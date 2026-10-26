(() => {
  if (globalThis.__gbpFiller056r32Loaded) return;
  globalThis.__gbpFiller056r32Loaded = true;
  const runtime = globalThis.__gbpFillerRuntime056r32 ||= {
    identity: undefined,
    lastSurface: "unknown",
    automationActive: false,
    pauseRequested: false,
    supervisedWriting: false,
    operatorInput: false,
    managerSourceUrl: undefined
  };
  // A real (trusted) click or key press in this frame while the panel writes is an operator
  // intervention: the current field is cancelled before Save and the queue stops.
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, event => {
    if (!event.isTrusted || !runtime.supervisedWriting) return;
    runtime.operatorInput = true;
    runtime.pauseRequested = true;
  }, true);
  const pausedBlocker = () => runtime.operatorInput ? "operator_input" : "operator_paused";
  const OPEN_EDITOR_TIMEOUT_MS = 45000;
  const ACTIVATE_TAB_TIMEOUT_MS = 20000;
  const CLOSE_EDITOR_TIMEOUT_MS = 20000;

  const text = element => (element?.innerText || element?.textContent || "").trim();
  const normalize = value => String(value || "")
    .normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
  const sha256 = async value => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map(item => item.toString(16).padStart(2, "0"))
      .join("");
  };
  const supportedHost = /^(?:www\.)?google\.(?:com|ru)$/.test(location.hostname)
    || location.hostname === "business.google.com";

  const isVisible = element => {
    if (element.closest('[aria-hidden="true"],[hidden],[inert]')) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    if (typeof element.checkVisibility === "function"
      && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 1
      && rect.height > 1
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < innerHeight
      && rect.left < innerWidth;
  };
  const roleElements = role =>
    [...document.querySelectorAll(`[role="${role}"]`)].filter(isVisible);
  const accessibleName = element => {
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/).filter(Boolean).map(id => text(document.getElementById(id))).filter(Boolean).join(" ");
    return normalize(
      element.getAttribute("aria-label")
      || labelledBy
      || element.getAttribute("title")
      || element.getAttribute("data-tooltip")
      || element.getAttribute("data-tooltip-text")
      || text(element)
    );
  };
  const findControl = patterns => [...document.querySelectorAll("button,[role=button],a")]
    .filter(isVisible)
    .find(element => patterns.some(pattern => pattern.test(accessibleName(element))));
  const closePattern = /^(?:close|закрыть)(?:\s+(?:dialog|window|panel|диалог|окно|панель))?$/;
  const backPattern = /^(?:back|назад)(?:\s+(?:to services|к услугам))?$/;
  const businessTabPattern = /^(?:about|основное|о компании|общая информация|contact|контакты|контактные данные|location|местоположение|hours|часы|часы работы|more|ещё|еще)(?:\s+(?:tab|вкладка)(?:\s+\d+\s+(?:of|из)\s+\d+)?)?$/;
  const businessTabCandidates = () => {
    const found = new Map();
    for (const node of document.querySelectorAll('button,a,div,span,[role="tab"],[role="button"],[tabindex]')) {
      if (!isVisible(node)) continue;
      const nodeName = accessibleName(node);
      if (!businessTabPattern.test(nodeName)) continue;
      const control = node.closest('button,a,[role="tab"],[role="button"],[tabindex]') || node;
      if (!isVisible(control)) continue;
      found.set(control, { control, name: nodeName });
    }
    return [...found.values()];
  };
  const closeControls = root => [...root.querySelectorAll('button,a,[role="button"],[data-tooltip],[data-tooltip-text]')]
    .filter(isVisible).filter(control => closePattern.test(accessibleName(control)));
  const visualPanelTitles = (root, titlePattern = /.+/) => [...root.querySelectorAll(
    'h1,h2,h3,[role="heading"],div,span'
  )]
    .filter(isVisible)
    .filter(element => titlePattern.test(normalize(text(element))))
    .filter(element => {
      if (element.matches('h1,h2,h3,[role="heading"]')) return true;
      const value = normalize(text(element));
      if (!value || [...element.children].some(child => normalize(text(child)) === value)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.height <= 96
        && rect.width >= 40
        && Number.parseFloat(style.fontSize) >= 18
        && Number.parseFloat(style.fontWeight) >= 400;
    })
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top || aRect.left - bRect.left;
    });
  const editorPanel = titlePattern => {
    const headings = visualPanelTitles(document, titlePattern);
    for (const heading of headings) {
      const dialog = heading.closest('[role="dialog"]');
      if (dialog && isVisible(dialog)) return dialog;
      let cursor = heading.parentElement;
      for (let depth = 0; cursor && depth < 12; depth++, cursor = cursor.parentElement) {
        const semanticRoot = cursor.matches('html,body,main,[role="main"]');
        if (semanticRoot) break;
        const rect = cursor.getBoundingClientRect();
        const headingRect = heading.getBoundingClientRect();
        const close = [...cursor.querySelectorAll("button,[role=button]")]
          .filter(isVisible)
          .find(control => closePattern.test(accessibleName(control)));
        const closeRect = close?.getBoundingClientRect();
        const closeBelongsToHeader = Boolean(closeRect
          && Math.abs(closeRect.top - headingRect.top) <= 160
          && closeRect.left >= headingRect.left
          && closeRect.top <= rect.top + 200);
        if (close
          && closeBelongsToHeader
          && rect.width >= 300
          && rect.height >= Math.min(300, innerHeight * 0.4)) {
          return cursor;
        }
      }
    }
    return undefined;
  };
  const businessInfoPanel = () => {
    const titled = editorPanel(/^(?:business information|business info|сведения о компании|информация о компании)(?:\s+(?:dialog|window|panel|диалог|окно|панель))?$/);
    if (titled) return titled;
    const tabItems = businessTabCandidates();
    const tabs = tabItems.map(item => item.control);
    const distinct = new Set(tabItems.map(item => item.name.replace(/\s+(?:tab|вкладка).*$/, "")));
    if (distinct.size < 3) return undefined;
    let cursor = tabs[0]?.parentElement;
    for (let depth = 0; cursor && depth < 12; depth++, cursor = cursor.parentElement) {
      if (cursor.matches('html,body')) break;
      if (!tabs.every(tab => cursor.contains(tab))) continue;
      const close = closeControls(cursor)[0];
      const fieldControls = [...cursor.querySelectorAll('button,a,input,textarea,[role="button"]')]
        .filter(isVisible).filter(control => !tabs.includes(control) && control !== close);
      if (close || (distinct.size >= 5 && fieldControls.length > 0)) return cursor;
    }
    return undefined;
  };
  // Google keeps zero-height OGS utility iframes in the dashboard.  They have
  // a non-zero width and therefore pass the generic `isVisible` check, but
  // they are not an editor and must never turn a normal dashboard into an
  // `*_iframe` blocker.
  const visibleEditorFrames = () => [...document.querySelectorAll("iframe")]
    .filter(frame => {
      if (!isVisible(frame)) return false;
      const rect = frame.getBoundingClientRect();
      return rect.width >= 280 && rect.height >= 180;
    });
  const businessInfoDiagnostics = () => ({
    knownTabs: businessTabCandidates().length,
    closeControls: closeControls(document).length,
    dialogs: roleElements("dialog").length,
    frames: visibleEditorFrames().length,
    businessInfoText: /business information|business info|сведения о компании|информация о компании/i.test(text(document.body))
  });
  const editorRoot = currentSurface => {
    if (currentSurface === "service_details") {
      return editorPanel(/^(?:edit service details|изменить сведения об услуге)$/);
    }
    if (currentSurface === "services") {
      return editorPanel(/^(?:services|edit services|add services|услуги|изменить услуги|редактировать услуги|добавить услуги)$/);
    }
    if (currentSurface === "business_info") {
      return businessInfoPanel();
    }
    return undefined;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const readIndicator = (detail, current, total) => {
    const id = "gbp-filler-read-indicator";
    let element = document.getElementById(id);
    if (!element) {
      element = document.createElement("div");
      element.id = id;
      element.setAttribute("aria-live", "polite");
      element.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:280px;padding:8px 11px;border:1px solid #8ab4f8;border-radius:8px;background:#202124;color:#e8eaed;font:12px/1.35 Arial,sans-serif;box-shadow:0 6px 20px #0008;pointer-events:none";
      document.documentElement.append(element);
    }
    element.textContent = `GBP Filler читает Google${total ? `: ${current}/${total}` : ""}. ${detail}`;
  };
  const report = (phase, detail, current = 0, total = 0) => {
    readIndicator(detail, current, total);
    chrome.runtime.sendMessage({
      type: "automation_progress",
      payload: { phase, detail, current, total }
    }).catch(() => {});
  };
  const waitFor = async (predicate, timeout = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = predicate();
      if (value) return value;
      await pause(100);
    }
    return undefined;
  };
  const waitForStableSurface = async (expected, timeout = 3500, settle = 400) => {
    const started = Date.now();
    let stableSince;
    while (Date.now() - started < timeout) {
      const body = text(document.body).slice(0, 12000);
      if (/captcha|я не робот|unusual traffic/i.test(body)) return { blocker: "captcha" };
      if (/verify it.?s you|verification required|подтвердите|пароль|password|2-step/i.test(body)) {
        return { blocker: "reverification" };
      }
      if (surface() === expected) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= settle) return { ok: true };
      } else {
        stableSince = undefined;
      }
      await pause(100);
    }
    const current = surface();
    return { blocker: safetyStop(text(document.body).slice(0, 12000), current) || `${expected}_unstable` };
  };
  const activateControl = async control => {
    control.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await pause(80);
    if (!control.isConnected || !isVisible(control)
      || control.matches(':disabled,[aria-disabled="true"]')) {
      return { activated: false, blocker: "edit_services_unavailable" };
    }
    control.focus({ preventScroll: true });
    await pause(40);
    const currentSurface = surface();
    const stop = safetyStop(text(document.body).slice(0, 12000), currentSurface);
    if (stop) return { activated: false, blocker: stop };
    if (["services", "service_details"].includes(currentSurface)) {
      return { activated: true };
    }
    if (currentSurface !== "dashboard"
      || !control.isConnected
      || !isVisible(control)
      || control.matches(':disabled,[aria-disabled="true"]')) {
      return { activated: false, blocker: "edit_services_unavailable" };
    }
    control.click();
    return { activated: true };
  };

  function locale(body) {
    if (/ваша компания|изменить профиль|ваши профили|сведения о компании/i.test(body)) return "ru";
    if (/компании|код магазина|профиль компании/i.test(body)
      && location.hostname === "business.google.com") return "ru";
    if (/your business|edit profile|your profiles|business information/i.test(body)) return "en";
    if (/google business profile manager|store code|see your profile/i.test(body)
      && location.hostname === "business.google.com") return "en";
    return "unknown";
  }

  function theme() {
    const value = getComputedStyle(document.body).backgroundColor
      || getComputedStyle(document.documentElement).backgroundColor;
    const rgb = (value.match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
    return rgb.length === 3 && ((rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000) < 128
      ? "dark"
      : "light";
  }

  function managerInventoryTable() {
    const tables = [...document.querySelectorAll('table,[role="table"],[role="grid"]')]
      .filter(isVisible);
    return tables.find(table => {
      const headers = [...table.querySelectorAll('th,[role="columnheader"]')]
        .map(element => normalize(text(element)));
      return headers.some(value => /^(?:business|бизнес)$/.test(value))
        && headers.some(value => /^(?:status|статус)$/.test(value))
        && headers.some(value => /^(?:store code|код магазина)$/.test(value));
    });
  }

  const ungroupedPattern = /^(?:ungrouped|без группировки|без группы)$/i;
  const managerGroupId = value => {
    if (!value) return undefined;
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin
        ? url.pathname.match(/^\/(?:u\/\d+\/)?groups\/(\d+)\/locations\/?$/)?.[1]
        : undefined;
    } catch { return undefined; }
  };
  const managerLoading = () => [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"][aria-label]')]
    .some(element => isVisible(element) && (element.getAttribute("aria-busy") === "true"
      || /loading|загрузка/i.test(accessibleName(element))))
    || text(document.body).split(/\n/).some(line => /^(?:loading|загрузка)[.…\s]*$/i.test(line.trim()));
  const managerEmptyEvidence = () => {
    const body = text(document.body);
    return Boolean(managerInventoryTable()) && !managerLoading()
      && /(?:^|\n)\s*0\s+(?:businesses|компаний|компании)\s*(?:\n|$)/i.test(body)
      && /you haven['’]t added any businesses|вы (?:ещ[её] )?не добавили (?:ни одной )?компании|компании пока не добавлены/i.test(body)
      && managerRows().length === 0;
  };

  const managerOptionsFor = control => control?.tagName === "SELECT" ? [...control.options]
    : control ? [...control.querySelectorAll('[role="option"]')].filter(option => option.closest('[role="listbox"]') === control) : [];
  const managerSelectedFor = control => {
    const selected = control?.tagName === "SELECT" ? [...control.selectedOptions]
      : managerOptionsFor(control).filter(option => option.getAttribute("aria-selected") === "true");
    return selected.length === 1 ? selected[0] : undefined;
  };
  const managerOptionValue = option => option?.getAttribute("data-value") || option?.value || "";
  const managerOptionId = option => /^\d+$/.test(managerOptionValue(option))
    ? managerOptionValue(option) : managerGroupId(managerOptionValue(option));
  const managerSelects = () => [...document.querySelectorAll('select,[role="listbox"]')].filter(element =>
      !element.closest('[aria-hidden="true"],[hidden],[inert]')
      && getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden");
  const managerGroupSelectors = selects => selects.filter(select => !select.multiple && select.getAttribute("aria-multiselectable") !== "true"
    && managerOptionsFor(select).some(option => ungroupedPattern.test(text(option))));

  function managerContextSnapshot(foundCount = 0, truncated = false) {
    // These are observed route/control hints, never stable account identity or write authorization.
    const accountRoute = location.pathname.match(/^\/u\/\d+(?=\/)/)?.[0];
    const selects = managerSelects();
    const groupSelectors = managerGroupSelectors(selects);
    const groupSelector = groupSelectors.length === 1 ? groupSelectors[0] : undefined;
    const selected = managerSelectedFor(groupSelector);
    const routeGroupId = managerGroupId(location.href);
    const selectedId = managerOptionId(selected);
    const selectionMatchesRoute = selected && text(selected) && (!routeGroupId || selectedId === routeGroupId);
    const conflictingSelection = routeGroupId && selected && !selectionMatchesRoute;
    const observedId = routeGroupId || selectedId;
    const group = selectionMatchesRoute
      ? { kind: ungroupedPattern.test(text(selected)) ? "ungrouped" : "group", label: text(selected), ...(observedId ? { id: observedId } : {}) }
      : { kind: "unknown", ...(routeGroupId ? { id: routeGroupId } : {}) };
    const availableGroups = groupSelector ? managerOptionsFor(groupSelector).map(option => {
      const id = managerOptionId(option);
      return { label: text(option), ...(id ? { id } : {}) };
    }) : [];
    const scope = group.kind !== "unknown" ? group.kind
      : !routeGroupId && groupSelectors.length === 0
        && /^\/(?:u\/\d+\/)?locations\/?$/.test(location.pathname) && surface() === "businesses"
        ? "current_list" : "unknown";
    const lines = text(document.body).split(/\n/).map(line => line.trim());
    const countMatch = lines.map(line => line.match(/^([\d ,]+)\s+(?:businesses|компаний|компании)$/i)).find(Boolean);
    const declaredCount = countMatch ? Number(countMatch[1].replace(/[ ,]/g, "")) : undefined;
    const pageMatch = lines.map(line => line.match(/^(\d+)\s*[-–—]\s*(\d+)\s+(?:of|из)\s+(\d+)$/i)).find(Boolean);
    const page = pageMatch ? { from: Number(pageMatch[1]), to: Number(pageMatch[2]), total: Number(pageMatch[3]) } : undefined;
    const labelFor = control => `${accessibleName(control)} ${[...(control.labels || [])].map(text).join(" ")}`;
    const statusSelectors = selects.filter(select => select !== groupSelector
      && managerOptionsFor(select).some(option => /^(?:all|все)\s*\(\d+\)$/i.test(text(option)))
      && managerOptionsFor(select).some(option => /^(?:verified|подтверждено)\s*\(\d+\)$/i.test(text(option))));
    const statusFilter = statusSelectors.length === 1 ? text(managerSelectedFor(statusSelectors[0])) : undefined;
    const pageSizeControls = selects.filter(select => /number of rows per page|rows per page|строк на странице/i.test(labelFor(select)));
    const pageSizeValue = pageSizeControls.length === 1 ? managerOptionValue(managerSelectedFor(pageSizeControls[0])) : "";
    const pageSize = /^\d+$/.test(pageSizeValue) ? Number(pageSizeValue) : undefined;
    const searches = [...document.querySelectorAll('input[type="search"],input[aria-label],input[placeholder]')]
      .filter(input => /search businesses|поиск компаний/i.test(`${labelFor(input)} ${input.placeholder || ""}`));
    const searchQuery = searches.length === 1 ? searches[0].value : undefined;
    const nextPage = [...document.querySelectorAll('button,[role="button"]')].some(control =>
      /^(?:next|next page|следующая|следующая страница)$/i.test(accessibleName(control))
      && !control.disabled && control.getAttribute("aria-disabled") !== "true");
    const completeness = scope !== "unknown" && managerEmptyEvidence()
      ? "confirmed_empty"
      : scope === "unknown" || conflictingSelection || truncated || managerLoading() || nextPage || (page && (page.from > 1 || page.to < page.total))
        || (declaredCount !== undefined && declaredCount > foundCount) ? "partial" : "current_page";
    return { accountRoute, scope, group, availableGroups, declaredCount, statusFilter, searchQuery, page, pageSize, completeness };
  }

  const managerContextSignature = ({ accountRoute, scope, group, statusFilter, searchQuery, page, pageSize }) =>
    JSON.stringify({ accountRoute, scope, group, statusFilter, searchQuery, page, pageSize });

  async function readManagerContext(foundCount = 0, truncated = false) {
    const context = managerContextSnapshot(foundCount, truncated);
    return { ...context, contextKey: await sha256(managerContextSignature(context)) };
  }

  // Live Manager 26.10 (R-68): Google's group listbox opens and selects on the
  // pointer/mouse press, not on a bare element.click(), so the options stayed
  // collapsed (zero height) and the group never changed. Press like a user.
  const pressLikeUser = target => {
    const rect = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    // Google listens on the inner trigger, so a press must reach the element a
    // real pointer would hit (only if it belongs to the intended control).
    const hit = document.elementFromPoint(init.clientX, init.clientY);
    const element = hit && target.contains(hit) ? hit : target;
    element.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mousedown", init));
    element.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseup", init));
    element.dispatchEvent(new MouseEvent("click", init));
  };

  async function prepareManagerGroupSelection(request) {
    // This command can only operate the observed group-navigation control.
    // It never constructs a route or touches business fields / Save controls.
    const validate = async () => {
      const currentSurface = surface();
      const stop = safetyStop(text(document.body), currentSurface);
      if (stop) return { blocker: stop };
      if (currentSurface !== "businesses") return { blocker: "manager_surface_changed" };
      if (managerLoading()) return { blocker: "manager_loading" };
      const context = await readManagerContext();
      if (!request?.contextKey || request.contextKey !== context.contextKey
        || managerContextSignature(managerContextSnapshot()) !== managerContextSignature(context)) return { blocker: "manager_context_changed" };
      const selectors = managerGroupSelectors(managerSelects());
      const control = selectors.length === 1 ? selectors[0] : undefined;
      if (!control || !isVisible(control) || control.matches(":disabled") || control.getAttribute("aria-disabled") === "true") {
        return { blocker: "manager_group_unavailable" };
      }
      const selected = managerSelectedFor(control);
      if (!selected || context.scope === "unknown") return { blocker: "manager_context_changed" };
      const matches = managerOptionsFor(control).filter(option => text(option) === request.label
        && managerOptionId(option) === request.groupId);
      if (matches.length !== 1 || matches[0].disabled || matches[0].closest("optgroup[disabled]")
        || matches[0].getAttribute("aria-disabled") === "true") return { blocker: "manager_group_unavailable" };
      return { control, option: matches[0], selected, context };
    };
    const stillSafe = target => target.control.isConnected && target.option.isConnected
      && isVisible(target.control) && !target.control.matches(":disabled") && target.control.getAttribute("aria-disabled") !== "true"
      && !target.option.disabled && !target.option.closest("optgroup[disabled]") && target.option.getAttribute("aria-disabled") !== "true"
      && !safetyStop(text(document.body), surface()) && surface() === "businesses" && !managerLoading()
      && managerContextSignature(managerContextSnapshot()) === managerContextSignature(target.context);
    const target = await validate();
    if (target.blocker) return { status: "blocked", blocker: target.blocker };
    if (target.option === target.selected) return { status: "ready" };
    return {
      status: "navigating",
      // R-68: every exit returns a reason ({ blocker }) so the panel can show why the
      // group did not change, instead of a silent return and a generic 12 s timeout.
      navigate: async () => {
        let fresh = await validate();
        if (fresh.blocker) return { blocker: fresh.blocker };
        if (!stillSafe(fresh)) return { blocker: "manager_context_changed" };
        if (fresh.control.tagName === "SELECT") {
          fresh.control.selectedIndex = [...fresh.control.options].indexOf(fresh.option);
          fresh.control.dispatchEvent(new Event("change", { bubbles: true }));
          return { status: "clicked" };
        }
        if (fresh.control.getAttribute("aria-expanded") !== "true") {
          pressLikeUser(fresh.control);
          // The listbox renders its options asynchronously after expanding.
          await waitFor(() => !fresh.option.isConnected || isVisible(fresh.option), 3000);
        }
        fresh = await validate();
        if (fresh.blocker) return { blocker: fresh.blocker };
        if (!stillSafe(fresh)) return { blocker: "manager_context_changed" };
        if (!isVisible(fresh.option)) return { blocker: "manager_group_option_not_visible" };
        pressLikeUser(fresh.option);
        return { status: "clicked" };
      }
    };
  }

  function isManagerNavigationDrawer(dialog) {
    if (!dialog || !isVisible(dialog)) return false;
    const ariaLabel = normalize(dialog.getAttribute("aria-label") || "");
    const drawerLabel = /^(?:navigational drawer|navigation drawer|навигационная панель)$/.test(ariaLabel);
    return drawerLabel && Boolean(dialog.querySelector('nav,[role="navigation"]'));
  }

  function isManagerShellDialog(dialog) {
    if (!dialog || !isVisible(dialog)) return false;
    if (isManagerNavigationDrawer(dialog)) return true;
    const rect = dialog.getBoundingClientRect();
    const viewportShell = rect.width >= innerWidth * 0.75
      && rect.height >= innerHeight * 0.75
      && rect.left <= innerWidth * 0.12
      && rect.top <= innerHeight * 0.12;
    const ariaLabel = normalize(dialog.getAttribute("aria-label") || "");
    const titles = visualPanelTitles(dialog).map(element => normalize(text(element)));
    const exactTitle = /^(?:(?:google )?business profile manager|менеджер профиля компании(?: в google)?)$/.test(ariaLabel)
      || titles.some(value => /^(?:(?:google )?business profile manager|менеджер профиля компании(?: в google)?)$/.test(value));
    const value = text(dialog);
    const structure = /businesses/i.test(value) && /store code/i.test(value);
    const nestedDialogs = [...dialog.querySelectorAll('[role="dialog"]')].filter(isVisible);
    return viewportShell && exactTitle && structure && nestedDialogs.length === 0;
  }

  function isManagerNonModalShell(dialog) {
    if (!dialog || !isVisible(dialog) || dialog.getAttribute("aria-modal") === "true") return false;
    const rect = dialog.getBoundingClientRect();
    return rect.width >= innerWidth * 0.75 && rect.height >= innerHeight * 0.75;
  }

  const dialogTitle = dialog => {
    const ariaLabel = normalize(dialog.getAttribute("aria-label") || "");
    if (ariaLabel) return ariaLabel;
    const heading = [...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .find(element => {
        if (element.closest('[role="dialog"],[role="alertdialog"]') !== dialog
          || element.closest('[aria-hidden="true"],[hidden],[inert]')) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
      });
    return normalize(heading ? text(heading) : "");
  };

  const discardChangesPrompt = () => {
    if (!runtime.automationActive) return undefined;
    const matching = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
      .filter(isVisible).filter(dialog =>
      /^(?:discard changes\??|отменить изменения\??|отказаться от изменений\??)$/.test(dialogTitle(dialog))
    );
    if (matching.length !== 1) return undefined;
    const dialog = matching[0];
    const controls = [...dialog.querySelectorAll('button,[role="button"]')].filter(isVisible);
    const confirm = controls.filter(control => /^(?:ok|ок)$/.test(accessibleName(control)));
    const cancel = controls.filter(control => /^(?:cancel|отмена)$/.test(accessibleName(control)));
    return confirm.length === 1 && cancel.length === 1 ? { dialog, confirm: confirm[0] } : undefined;
  };

  function surface() {
    const dialogs = roleElements("dialog");
    const body = text(document.body).slice(0, 16000);
    const managerOverlay = dialogs.length === 0
      || (dialogs.length === 1 && (isManagerShellDialog(dialogs[0])
        || isManagerNavigationDrawer(dialogs[0])
        || isManagerNonModalShell(dialogs[0])));
    const managerRows = [...document.querySelectorAll('tr,[role="row"]')].filter(isVisible);
    const managerCheckboxes = [...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(isVisible);
    const knownManagerWords = /(?:businesses|компании)/i.test(body)
      && /(?:store code|код магазина)/i.test(body)
      && (/(?:google business profile manager|менеджер профиля компании|search businesses|поиск компаний)/i.test(body)
        // Live en Manager 26.10: the product name is a logo image and «Search
        // businesses» is only the search field placeholder, so an empty list
        // had no text evidence at all.
        || [...document.querySelectorAll("input[placeholder],input[aria-label]")].some(input =>
          /^(?:search businesses|поиск компаний)$/i.test((input.getAttribute("placeholder") || input.getAttribute("aria-label") || "").trim())));
    // On /locations the repeated selectable rows are stronger evidence than a
    // translated heading. Labels only help with sparse one-row lists.
    const structuralManagerList = managerCheckboxes.length >= 2
      && (managerRows.length >= 2 || [...document.querySelectorAll("body *")].some(element => {
        if (!isVisible(element)) return false;
        const checks = [...element.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(isVisible);
        return checks.length >= 2 && checks.length <= 200;
      }));
    const managerPage = location.hostname === "business.google.com"
      && /\/locations(?:[/?]|$)/.test(location.pathname)
      && managerOverlay
      && (knownManagerWords || structuralManagerList);
    if (managerPage) return "businesses";
    const knownServiceStack = dialogs.length === 2
      && dialogs.some(dialog => /^(?:services|edit services|add services|услуги|изменить услуги|редактировать услуги|добавить услуги)$/.test(dialogTitle(dialog)))
      && dialogs.some(dialog => /^(?:edit service details|изменить сведения об услуге)$/.test(dialogTitle(dialog)));
    if (knownServiceStack) return "service_details";
    // The embedded editor may contain an additional Google dialog, but a
    // titled panel with its own close control is still a stronger Services
    // surface than the raw dialog count.
    if (dialogs.length > 1) {
      if (editorRoot("service_details")) return "service_details";
      if (editorRoot("services")) return "services";
      return "unknown";
    }
    if (dialogs.length === 1) {
      const dialog = dialogs[0];
      const title = dialogTitle(dialog);
      if (/^(?:edit service details|изменить сведения об услуге)$/.test(title)) {
        return "service_details";
      }
      if (/^(?:services|edit services|add services|услуги|изменить услуги|редактировать услуги|добавить услуги)$/.test(title)) {
        return "services";
      }
      if (/^(?:business information|business info|сведения о компании|информация о компании)(?:\s+(?:dialog|window|panel|диалог|окно|панель))?$/.test(title)) {
        return "business_info";
      }
      const infoPanel = businessInfoPanel();
      if (infoPanel && (dialog === infoPanel || dialog.contains(infoPanel) || infoPanel.contains(dialog))) {
        return "business_info";
      }
      return "unknown";
    }
    if (editorRoot("service_details")) return "service_details";
    if (editorRoot("services")) return "services";
    if (editorRoot("business_info")) return "business_info";
    if (/your profiles|ваши профили/i.test(body)) return "profiles";
    if (/your business on google|ваша компания в google/i.test(body)) return "dashboard";
    return "unknown";
  }

  function safetyStop(body, currentSurface) {
    if (/captcha|я не робот|unusual traffic/i.test(body)) return "captcha";
    if (/verify it.?s you|verification required|подтвердите|пароль|password|2-step/i.test(body)) {
      return "reverification";
    }
    const dialogs = roleElements("dialog");
    const knownDialog = ["business_info", "services", "service_details"].includes(currentSurface);
    const knownServiceStack = currentSurface === "service_details" && dialogs.length === 2
      && Boolean(editorRoot("services")) && Boolean(editorRoot("service_details"));
    const managerShell = currentSurface === "businesses" && dialogs.length === 1
      && (isManagerShellDialog(dialogs[0])
        || isManagerNavigationDrawer(dialogs[0])
        || isManagerNonModalShell(dialogs[0]));
    if ((dialogs.length > 1 && !knownServiceStack)
      || (dialogs.length === 1 && !knownDialog && !managerShell)) return "unknown_dialog";
    return undefined;
  }

  function serviceSurfaceDiagnostics(expected) {
    const dialogs = roleElements("dialog");
    const classify = dialog => {
      const title = dialogTitle(dialog);
      if (/^(?:services|edit services|add services|услуги|изменить услуги|редактировать услуги|добавить услуги)$/.test(title)) return "services";
      if (/^(?:edit service details|изменить сведения об услуге)$/.test(title)) return "service_details";
      return title ? "other" : "untitled";
    };
    return {
      serviceExpected: expected,
      serviceSurface: surface(),
      serviceDialogs: dialogs.length,
      serviceDialogKinds: dialogs.map(classify),
      serviceInputs: [...document.querySelectorAll("input")].filter(isVisible).length,
      serviceTextareas: [...document.querySelectorAll("textarea")].filter(isVisible).length,
      serviceBackControls: [...document.querySelectorAll('button,a,[role="button"]')]
        .filter(isVisible).filter(control => backPattern.test(accessibleName(control))).length,
      serviceCloseControls: closeControls(document).length
    };
  }

  function extractIdentity() {
    const managerPattern = /you manage this business profile|вы управляете (?:этим )?профилем (?:этой |данной )?компании/i;
    const rejectedName = /^(?:skip to main content|перейти к основному содержанию|read more|читать далее|your business on google|ваша компания в google|edit profile|изменить профиль|profile strength|качество профиля|complete info|заполнить профиль|verified|подтверждено|pending|ожидает проверки|read reviews|читать отзывы|photos|фото|performance|эффективность|advertise|реклама|edit services|изменить услуги|bookings|бронирования|website|сайт|directions|маршрут|address|адрес|phone|телефон|hours|часы|updated by this business.*|обновлено компанией.*|\d+\s+customer interactions?|\d+\s+взаимодейств.*)$/i;
    const dashboardAddressLike = value =>
      value.length >= 8
      && value.length < 500
      && /\p{L}/u.test(value)
      && /\d/.test(value)
      && !/^(?:phone|телефон|hours|часы|website|сайт|add|добавить|directions|маршрут)\s*:/i.test(value)
      && /(ул\.?|улиц|ulitsa|street|st\.|road|avenue|просп|prospekt|переул|pereulok|площад|ploshchad|шоссе|shosse|наб\.?|naberezhnaya|б-р|bulvar|пер\.|proyezd|област|oblast|район|district|,)/i.test(value);

    const managerElement = [...document.querySelectorAll("div,span")]
      .filter(element => {
        const value = text(element);
        return isVisible(element) && value.length < 180 && managerPattern.test(value);
      })
      .sort((a, b) => text(a).length - text(b).length)[0];

    let cursor = managerElement?.parentElement;
    let profileRoot;
    for (let depth = 0; cursor && depth < 16; depth++, cursor = cursor.parentElement) {
      const value = text(cursor);
      if (/(?:address|адрес)\s*:/i.test(value) && value.length < 12000) {
        profileRoot = cursor;
        break;
      }
    }
    if (!profileRoot) return { name: "", address: "" };

    const markerRect = managerElement.getBoundingClientRect();
    const profileLines = text(profileRoot).split("\n").map(value => value.trim()).filter(Boolean);
    const managerLine = profileLines.findIndex(value => managerPattern.test(value));
    const addressIndexes = profileLines
      .map((value, index) => /^(?:address|адрес)\s*:/i.test(value) ? index : -1)
      .filter(index => index >= 0 && managerLine >= 0 && Math.abs(index - managerLine) <= 40)
      .sort((a, b) => {
        const aAfter = a > managerLine ? 0 : 1;
        const bAfter = b > managerLine ? 0 : 1;
        return aAfter - bAfter || Math.abs(a - managerLine) - Math.abs(b - managerLine);
      });
    const addressIndex = addressIndexes[0] ?? -1;
    const labeledAddress = addressIndex >= 0 ? profileLines[addressIndex] : "";
    const inlineAddress = labeledAddress.replace(/^(?:address|адрес)\s*:\s*/i, "");
    const separateAddress = addressIndex >= 0 ? profileLines[addressIndex + 1] || "" : "";
    const addressCandidate = inlineAddress || separateAddress;
    const address = dashboardAddressLike(addressCandidate) ? addressCandidate : "";
    const localNameSet = new Set(
      profileLines
        .slice(Math.max(0, managerLine - 8), managerLine)
        .map(normalize)
    );

    const titleCandidates = [...profileRoot.querySelectorAll('h1,h2,h3,[role="heading"],div,span')]
      .filter(isVisible)
      .map(element => {
        const value = text(element);
        const rect = element.getBoundingClientRect();
        return {
          value,
          semanticHeading: element.matches('h1,h2,h3,[role="heading"]'),
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize) || 0,
          distance: markerRect.top - rect.bottom,
          horizontalDistance: Math.abs(rect.left - markerRect.left),
          singleLine: !value.includes("\n")
        };
      })
      .filter(candidate =>
        candidate.singleLine
        && candidate.value.length > 2
        && candidate.value.length < 140
        && !rejectedName.test(candidate.value)
        && candidate.fontSize >= 17
        && candidate.distance >= 0
        && candidate.distance < 220
        && candidate.horizontalDistance < 180
        && localNameSet.has(normalize(candidate.value))
      )
      .sort((a, b) => Number(b.semanticHeading) - Number(a.semanticHeading)
        || b.fontSize - a.fontSize || a.distance - b.distance);
    const name = titleCandidates[0]?.value || "";
    return { name, address };
  }

  const managerProfilePattern = /^(?:see your profile|my profile|посмотреть профиль|открыть профиль|мой профиль)$/i;
  const managerActionSuffixPattern = /\s*(?:see your profile|my profile|посмотреть профиль|открыть профиль|мой профиль)\s*$/i;
  const managerRowTokens = new WeakMap();
  let managerRowTokenSequence = 0;
  const managerRowToken = row => {
    if (!row) return undefined;
    let token = managerRowTokens.get(row);
    if (!token) {
      token = `manager-row-${++managerRowTokenSequence}`;
      managerRowTokens.set(row, token);
    }
    return token;
  };
  // Live Manager 26.10: «Уфимский тракт, 1А, …, 453110», «Бумажный пр-д, 15, Москва, 127015».
  // A Russian postal code closing a comma-separated line is an address too.
  const managerAddressPattern = value =>
    /\d/.test(value)
    && value.includes(",")
    && (/(ул\.?|улиц|ulitsa|street|st\.|road|avenue|просп|prospekt|переул|pereulok|площад|ploshchad|шоссе|shosse|наб\.?|naberezhnaya|б-р|bulvar|пер\.|proyezd|проезд|пр-д|тракт|тупик|аллея|мкр|микрорайон|квартал|област|oblast|район|district)/i.test(value)
      || (/,\s*\d{6}$/.test(value) && value.split(",").length >= 3));
  // R-65/R-79: Manager also shows "Обработка…" (processing) and "Требуется подтверждение".
  // Only captions observed in Google UI are listed; anything else stays unknown, not guessed.
  const managerStatusPattern = /^(?:verified|подтверждено?|blocked|заблокирован[аоы]?|suspended|приостановлен[аоы]?|disabled|отключен[аоы]?|pending|ожидает подтверждения|processing|обработка|требуется подтверждение|verification required|needs verification)(?:…|\.\.\.)?$/i;
  const managerExcludedLine = value =>
    !value
    || /^\d+$/.test(value)
    || managerProfilePattern.test(value)
    || managerStatusPattern.test(value)
    // R-61: action-button captions in a row are never a business name.
    || /^(?:подтвердить(?: данные)?|verify(?: now)?|get verified)$/i.test(value)
    || /^(?:store code|код магазина|business|бизнес|company|компания|status|статус)$/i.test(value);

  const managerRowForControl = control => {
    const semanticRow = control.closest('tr,[role="row"]');
    if (semanticRow) return semanticRow;
    let fallback;
    let cursor = control.parentElement;
    for (let depth = 0; cursor && depth < 7; depth++, cursor = cursor.parentElement) {
      const lines = text(cursor).split("\n").map(value => value.trim()).filter(Boolean);
      const controls = [...cursor.querySelectorAll("a,button,[role=button]")]
        .filter(isVisible).filter(item => managerProfilePattern.test(accessibleName(item)));
      if (lines.length >= 2 && lines.length <= 12 && controls.length === 1) fallback = cursor;
      if (lines.some(managerAddressPattern) && fallback) return fallback;
    }
    return fallback;
  };

  const managerRowsForCheckboxes = () => {
    const rows = [];
    for (const checkbox of [...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(isVisible)) {
      let fallback;
      let cursor = checkbox.parentElement;
      for (let depth = 0; cursor && depth < 10; depth++, cursor = cursor.parentElement) {
        const checks = [...cursor.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(isVisible);
        const lines = text(cursor).split("\n").map(value => value.trim()).filter(Boolean);
        if (!fallback && checks.length === 1 && (
          cursor.matches('tr,[role="row"]') || (lines.length >= 2 && lines.length <= 20)
        )) fallback = cursor;
        if (checks.length === 1 && lines.some(managerAddressPattern) && fallback) {
          rows.push(fallback);
          break;
        }
      }
      if (fallback) rows.push(fallback);
    }
    return [...new Set(rows)];
  };

  const managerRows = () => [...new Set([
    ...[...document.querySelectorAll('tr,[role="row"]')].filter(isVisible),
    ...managerRowsForCheckboxes(),
    ...[...document.querySelectorAll("a,button,[role=button]")]
      .filter(isVisible)
      .filter(control => managerProfilePattern.test(accessibleName(control)))
      .map(managerRowForControl)
      .filter(Boolean)
  ])].filter(row => !row.querySelector('th,[role="columnheader"]'));

  const managerCellForHeader = (row, headers, header) => {
    if (!header) return undefined;
    const cells = [...row.querySelectorAll('td,[role="cell"]')];
    const ariaColumn = header.getAttribute("aria-colindex");
    const matchingCells = ariaColumn
      ? cells.filter(cell => cell.getAttribute("aria-colindex") === ariaColumn)
      : [];
    if (matchingCells.length === 1) return matchingCells[0];
    if (ariaColumn) return undefined;
    const headerRow = header.closest('tr,[role="row"]');
    const siblingHeaders = headerRow ? [...headerRow.querySelectorAll('th,[role="columnheader"]')] : [];
    const index = siblingHeaders.indexOf(header);
    return index >= 0 && siblingHeaders.length === cells.length ? cells[index] : undefined;
  };

  const managerRowData = row => {
    const table = row.closest('table,[role="table"],[role="grid"]');
    const headers = table ? [...table.querySelectorAll('th,[role="columnheader"]')] : [];
    const cells = [...row.querySelectorAll('td,[role="cell"]')];
    const exactHeader = pattern => {
      const matches = headers.filter(element => pattern.test(text(element).trim()));
      return matches.length === 1 ? matches[0] : undefined;
    };
    const businessCell = managerCellForHeader(row, headers, exactHeader(/^(?:business|бизнес)$/i));
    const visibleValues = businessCell
      ? text(businessCell)
      : (cells.length ? cells.map(text).join("\n") : text(row));
    const lines = visibleValues.split("\n")
      .map(value => value.replace(managerActionSuffixPattern, "").trim())
      // Google glues the store code to the name: «12069924816704175235⇥Похмельная служба».
      .flatMap(value => value.split("\t").map(part => part.trim()))
      .filter(Boolean);
    const addressIndex = lines.findIndex(managerAddressPattern);
    const address = addressIndex >= 0 ? lines[addressIndex] : undefined;
    const nameLines = addressIndex >= 0 ? lines.slice(0, addressIndex) : lines;
    const name = [...nameLines].reverse().find(value =>
      value.length > 2 && value.length < 140 && !managerExcludedLine(value)
    );
    const storeCell = managerCellForHeader(row, headers, exactHeader(/^(?:store code|код магазина)$/i));
    const storeCode = text(storeCell || "").trim()
      || nameLines.find(value => /^\d{6,}$/.test(value))
      || undefined;
    const statusCell = managerCellForHeader(row, headers, exactHeader(/^(?:status|статус)$/i));
    const statusFromCell = text(statusCell || "").trim();
    // R-79: a status cell may hold an icon glyph and an action link next to the caption;
    // keep Google's own caption from that cell before falling back to the business lines.
    const statusCellLines = statusFromCell.split("\n").map(value => value.trim()).filter(Boolean);
    const status = statusFromCell && statusFromCell.length < 140 && !statusFromCell.includes("\n")
      ? statusFromCell
      : statusCellLines.find(line => managerStatusPattern.test(line)) || lines.find(line => managerStatusPattern.test(line));
    return { name, address, storeCode, status, verified: Boolean(status && /^(?:verified|подтверждено?)$/i.test(status)) };
  };

  function collectManagerProfiles() {
    const candidates = [];
    const seenRows = new Set();
    for (const row of managerRows()) {
      if (seenRows.has(row)) continue;
      seenRows.add(row);
      const { name, address, storeCode, status, verified } = managerRowData(row);
      if (!name || !address) continue;
      const control = [...row.querySelectorAll("a,button,[role=button]")]
        .find(item => isVisible(item) && managerProfilePattern.test(accessibleName(item)));
      const sourceKey = managerRowToken(row);
      const key = `${normalize(name)}|${normalize(address)}|${normalize(storeCode)}|${sourceKey}`;
      candidates.push({
        data: {
          key,
          sourceKey,
          name,
          address,
          storeCode: storeCode || undefined,
          openable: Boolean(control),
          status,
          verified
        },
        control
      });
      if (candidates.length >= 200) break;
    }
    return candidates;
  }

  function collectManagerUnresolved() {
    const unresolved = [];
    const seen = new Set();
    for (const row of managerRows()) {
      if (!row || seen.has(row)) continue;
      seen.add(row);
      const { name, address, storeCode, status } = managerRowData(row);
      if (name && address) continue;
      // Keep each incomplete visible row separate for review. Neither a name
      // nor a Store code is an identity, so incomplete rows never collapse.
      const key = `${normalize(name)}|${normalize(address)}|${managerRowToken(row)}`;
      if (unresolved.some(item => item.key === key)) continue;
      unresolved.push({
        key,
        name: name || undefined,
        address: address || undefined,
        storeCode,
        status,
        reason: !address ? "address_missing" : !name ? "name_missing" : "identity_incomplete"
      });
    }
    return unresolved;
  }

  async function openManagerProfile(candidate) {
    const body = text(document.body);
    const currentSurface = surface();
    const stop = safetyStop(body, currentSurface);
    if (stop) return { status: "blocked", blocker: stop };
    if (currentSurface !== "businesses") {
      return { status: "blocked", blocker: "manager_surface_changed" };
    }
    if (!candidate?.name || !candidate?.address) {
      return { status: "blocked", blocker: "manager_selection_invalid" };
    }
    const matches = collectManagerProfiles().filter(item =>
      normalize(item.data.name) === normalize(candidate.name)
      && normalize(item.data.address) === normalize(candidate.address)
      && (!candidate.storeCode || normalize(item.data.storeCode) === normalize(candidate.storeCode))
    );
    if (matches.length !== 1) {
      return {
        status: "blocked",
        blocker: matches.length ? "manager_selection_ambiguous" : "manager_selection_stale"
      };
    }
    if (!matches[0].control) return { status: "blocked", blocker: "manager_selection_invalid" };
    report("navigate", `Открываем выбранную карточку: ${candidate.name}.`);
    if (candidate.managerContextKey) {
      const context = await readManagerContext();
      if ((context.group.kind === "unknown" && context.scope !== "current_list") || context.contextKey !== candidate.managerContextKey
        || managerContextSignature(managerContextSnapshot()) !== managerContextSignature(context)) {
        return { status: "blocked", blocker: "manager_context_changed" };
      }
      const stopBeforeClick = safetyStop(text(document.body), surface());
      if (stopBeforeClick) return { status: "blocked", blocker: stopBeforeClick };
      if (surface() !== "businesses") return { status: "blocked", blocker: "manager_surface_changed" };
    }
    runtime.identity = undefined;
    runtime.managerSourceUrl = location.href;
    matches[0].control.click();
    // A click acknowledgement is not enough: Manager may keep a stale row,
    // show an intermediate surface, or open another card.  The queue may
    // proceed only after the dashboard proves the requested identity.
    const opened = await waitFor(() => {
      const current = surface();
      const body = text(document.body).slice(0, 12000);
      const stop = safetyStop(body, current);
      if (stop === "captcha" || stop === "reverification") return { blocker: stop };
      if (current !== "dashboard") return undefined;
      const identity = extractIdentity();
      if (!identity.name || !identity.address) return undefined;
      if (normalize(identity.name) !== normalize(candidate.name)
        || normalize(identity.address) !== normalize(candidate.address)) {
        return { blocker: "manager_open_identity_mismatch" };
      }
      runtime.identity = identity;
      return { ready: true };
    }, OPEN_EDITOR_TIMEOUT_MS);
    return opened?.ready
      ? { status: "ready" }
      : { status: "blocked", blocker: opened?.blocker || "manager_open_timeout" };
  }

  async function returnToManager() {
    const sourceUrl = runtime.managerSourceUrl;
    const currentSurface = surface();
    const stop = safetyStop(text(document.body).slice(0, 12000), currentSurface);
    if (stop) return { status: "blocked", blocker: stop };
    // Content scripts do not survive a full history navigation reliably.  They
    // only prove the original Manager URL; the background owns the actual tab
    // navigation and waits for the reloaded list.
    if (!sourceUrl || location.href === sourceUrl) {
      return { status: "blocked", blocker: "manager_return_unproven" };
    }
    const source = new URL(sourceUrl);
    if (source.hostname !== location.hostname || !/\/locations(?:[/?]|$)/.test(source.pathname)) {
      return { status: "blocked", blocker: "manager_return_unproven" };
    }
    return { status: "return_ready", managerUrl: sourceUrl };
  }

  function inspect() {
    if (location.protocol !== "https:" || !supportedHost) {
      return { blocker: "unsupported_host", servicesComplete: false };
    }
    const body = text(document.body);
    const currentSurface = surface();
    const identity = extractIdentity();
    if (currentSurface === "dashboard") {
      runtime.identity = identity.name && identity.address ? identity : undefined;
    } else if (["businesses", "profiles"].includes(currentSurface)
      || (currentSurface === "unknown" && !runtime.automationActive)) {
      runtime.identity = undefined;
    }
    const childSurface = ["business_info", "services", "service_details"].includes(currentSurface);
    const anchoredIdentity = currentSurface === "dashboard"
      ? identity
      : ((childSurface || (runtime.automationActive && currentSurface === "unknown"))
        ? runtime.identity || identity
        : identity);
    const blocker = safetyStop(body, currentSurface)
      || (currentSurface === "businesses"
        ? "manager_selection_required"
        : (!anchoredIdentity.name || !anchoredIdentity.address ? "identity_incomplete" : undefined));
    runtime.lastSurface = currentSurface;
    return {
      ...anchoredIdentity,
      city: "",
      description: undefined,
      services: [],
      categories: [],
      serviceArea: [],
      payments: {},
      amenities: {},
      locale: locale(body),
      theme: theme(),
      surface: currentSurface,
      managerProfiles: currentSurface === "businesses"
        ? collectManagerProfiles().map(item => item.data)
        : undefined,
      managerUnresolved: currentSurface === "businesses"
        ? collectManagerUnresolved()
        : undefined,
      automation: "controlled_dom",
      stateHash: undefined,
      blocker,
      completeness: {
        identity: Boolean(anchoredIdentity.name && anchoredIdentity.address),
        businessInfo: false,
        services: false,
        categories: false,
        attributes: false
      },
      servicesComplete: false
    };
  }

  async function inspectStrong() {
    const snapshot = inspect();
    return {
      ...snapshot,
      managerContext: snapshot.surface === "businesses" ? await readManagerContext() : undefined,
      ...(snapshot.surface === "businesses" && runtime.managerGroupNavigation
        ? { managerGroupNavigation: runtime.managerGroupNavigation } : {}),
      stateHash: await sha256(`${location.href}\n${text(document.body)}`)
    };
  }

  async function readProfileStrength() {
    const before = await inspectStrong();
    const capturedAt = new Date().toISOString();
    if (before.surface !== "dashboard" || before.blocker || !before.name || !before.address) {
      return { state: "blocked", blocker: before.blocker || "dashboard_required", capturedAt, name: before.name, address: before.address };
    }
    if (!["ru", "en"].includes(before.locale)) {
      return { state: "blocked", blocker: "unsupported_locale", capturedAt, name: before.name, address: before.address };
    }
    const headingPattern = /^(?:profile strength|сила профиля|качество профиля|состояние профиля)$/i;
    // Structure first, because Google rewords often (recon 22.10): the quality ring is an SVG with a track
    // circle and a fill circle carrying stroke-dasharray. Its colour decides the state; words are only shown.
    // The ring is aria-hidden by Google, so visibility is checked by layout, not by isVisible().
    const rings = [...document.querySelectorAll("svg")]
      .filter(svg => { const box = svg.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(svg).visibility !== "hidden"; })
      .filter(svg => svg.querySelectorAll("circle").length === 2 && svg.querySelector("circle[stroke-dasharray]"));
    const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"],span,div')]
      .filter(isVisible)
      .filter(element => headingPattern.test(text(element).trim()))
      .filter(element => text(element).length < 80)
      // Google wraps the label and its ring in one box with the same text: keep the innermost label only.
      .filter((element, _index, all) => !all.some(other => other !== element && element.contains(other)));
    if (rings.length > 1 || headings.length > 1) {
      return { state: "blocked", blocker: "profile_strength_ambiguous", capturedAt, name: before.name, address: before.address };
    }
    if (!rings.length && !headings.length) {
      // A profile Google hides or suspends has no quality block, only this banner.
      const hidden = [...document.querySelectorAll("div,span,h2,h3")].filter(isVisible)
        .map(element => text(element)).find(value => /^(?:ваша компания не видна пользователям|your business isn.t visible[^.]*)$/i.test(value));
      if (hidden) return { state: "not_visible", rawLabel: hidden, capturedAt, name: before.name, address: before.address };
      return { state: "unavailable", capturedAt, name: before.name, address: before.address };
    }
    // Climb only until Google's own words appear next to the heading/ring — never into the whole card.
    const withoutHeading = element => text(element).replace(/^(?:profile strength|сила профиля|качество профиля|состояние профиля)\s*/i, "").trim();
    let container = rings[0] || headings[0];
    for (let depth = 0; depth < 4 && container.parentElement && !withoutHeading(container); depth++) container = container.parentElement;
    const rawLabel = withoutHeading(container).slice(0, 80) || undefined;
    const fill = rings[0]?.querySelector("circle[stroke-dasharray]");
    const radius = Number(fill?.getAttribute("r"));
    const dash = Number(String(fill?.getAttribute("stroke-dasharray") || "").trim().split(/[\s,]+/)[0]);
    const ring = fill && radius > 0 && Number.isFinite(dash)
      ? { percent: Math.max(0, Math.min(100, Math.round(dash / (2 * Math.PI * radius) * 100))), color: getComputedStyle(fill).stroke }
      : {};
    const byColour = strengthByColour(ring.color);
    const looksGood = /looks good!?|выглядит хорошо!?|вс[её] в порядке/i.test(rawLabel || "");
    const actionRequired = /complete info|complete your profile|заполните профиль|дополните информацию/i.test(rawLabel || "");
    const after = await inspectStrong();
    if (normalize(before.name) !== normalize(after.name) || normalize(before.address) !== normalize(after.address)) {
      return { state: "blocked", blocker: "profile_strength_identity_changed", capturedAt, name: after.name, address: after.address };
    }
    const byWords = looksGood && actionRequired ? "ambiguous" : looksGood ? "looks_good" : actionRequired ? "action_required" : undefined;
    // Colour and words must not contradict each other; either alone is enough.
    if (byWords === "ambiguous" || (byColour && byWords && byColour !== byWords)) {
      return { state: "blocked", blocker: "profile_strength_ambiguous", rawLabel, ...ring, capturedAt, name: before.name, address: before.address };
    }
    const state = byColour || byWords;
    if (state) return { state, rawLabel, ...ring, capturedAt, name: before.name, address: before.address };
    // Unknown is never success, but Google's own words and colour are kept for the operator.
    return { state: "unknown", blocker: "profile_strength_unknown_label", rawLabel, ...ring, capturedAt, name: before.name, address: before.address };
  }

  // Google's ring colour: green = in order; yellow, orange or red = needs more info. Grey or unknown → no verdict.
  function strengthByColour(color) {
    const [r, g, b] = (String(color || "").match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(value => Number(value) / 255);
    if (![r, g, b].every(Number.isFinite)) return undefined;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === 0 || (max - min) / max < 0.25) return undefined;
    const hue = max === r ? 60 * (((g - b) / (max - min)) % 6) : max === g ? 60 * ((b - r) / (max - min) + 2) : 60 * ((r - g) / (max - min) + 4);
    const degrees = (hue + 360) % 360;
    if (degrees >= 80 && degrees <= 170) return "looks_good";
    if (degrees <= 70 || degrees >= 330) return "action_required";
    return undefined;
  }

  const childNavigationBlocker = (snapshot, fallback) =>
    snapshot.blocker && snapshot.blocker !== "identity_incomplete"
      ? snapshot.blocker
      : fallback;

  const fieldDefinitions = [
    ["about", "businessName", "Название компании", "text", /^(?:business name|название компании)$/],
    ["about", "categories", "Категории", "list", /^(?:business category|категория компании|категории|вид деятельности)$/],
    ["about", "description", "Описание", "long_text", /^(?:description|описание)$/],
    ["contact", "openingDate", "Дата открытия", "date", /^(?:opening date|дата открытия)$/],
    ["contact", "phone", "Телефон", "phone", /^(?:phone number|телефон|номер телефона)$/],
    ["contact", "chat", "Чат", "text", /^(?:chat|чат)$/],
    ["contact", "website", "Сайт", "url", /^(?:website|сайт)$/],
    ["contact", "socialProfiles", "Социальные профили", "list", /^(?:social profiles|социальные профили|профили в социальных сетях)$/],
    ["location", "businessLocation", "Адрес", "text", /^(?:business location|адрес компании|местоположение компании)$/],
    ["location", "serviceArea", "Зона обслуживания", "list", /^(?:service area|service areas|зона обслуживания|район обслуживания|территория обслуживания)$/],
    ["hours", "hours", "Основные часы", "hours", /^(?:hours|business hours|opening hours|open with main hours|основные часы|часы работы|открыто в основные часы)$/],
    ["hours", "specialHours", "Специальные часы", "hours", /^(?:special hours|специальные часы|измененный график|изменённый график)$/],
    ["hours", "onlineHours", "Онлайн-часы", "hours", /^(?:online(?:\s+(?:operating|service|customer))?\s+hours|online-hours|онлайн(?:\s+(?:рабочие|операционные))?[-\s]часы|часы онлайн-обслуживания)$/],
    ["hours", "moreHours", "Дополнительные часы", "hours", /^(?:add more hours|more hours|дополнительные часы)$/]
  ];
  const tabPatterns = {
    about: /^(?:about|основное|о компании|общая информация)(?:\s+(?:tab|вкладка)(?:\s+\d+\s+(?:of|из)\s+\d+)?)?$/,
    contact: /^(?:contact|контакты|контактные данные)(?:\s+(?:tab|вкладка)(?:\s+\d+\s+(?:of|из)\s+\d+)?)?$/,
    location: /^(?:location|местоположение)(?:\s+(?:tab|вкладка)(?:\s+\d+\s+(?:of|из)\s+\d+)?)?$/,
    hours: /^(?:hours|часы|часы работы)(?:\s+(?:tab|вкладка)(?:\s+\d+\s+(?:of|из)\s+\d+)?)?$/,
    more: /^(?:more|ещё|еще)(?:\s+(?:tab|вкладка)(?:\s+\d+\s+(?:of|из)\s+\d+)?)?$/
  };
  const controlLines = control => {
    const leafValues = [...control.querySelectorAll("span,div,p")]
      .filter(isVisible)
      .filter(element => ![...element.children].some(isVisible))
      .map(element => text(element).trim())
      .filter(Boolean);
    return leafValues.length > 1
      ? leafValues
      : text(control).split("\n").map(value => value.trim()).filter(Boolean);
  };
  const explicitEmptyPattern = /^(?:not set|not provided|not available|не указано|не задано|нет данных)$/i;
  const addInsteadOfValuePattern = /^(?:add|добавить)$/i;
  const capturedValuePresent = value => Array.isArray(value)
    ? value.length > 0
    : typeof value === "boolean" || typeof value === "number"
      || (typeof value === "string" && value.trim().length > 0);
  const capturedReadState = (value, source) => {
    if (capturedValuePresent(value)) return "present";
    const lines = [
      ...controlLines(source),
      ...text(source).split("\n").map(item => item.trim()).filter(Boolean)
    ];
    return lines.some(item => explicitEmptyPattern.test(item) || addInsteadOfValuePattern.test(item)) ? "empty" : "unknown";
  };
  const captureValue = (control, label, kind, labelPattern) => {
    const lines = controlLines(control);
    const ignored = /^(?:add|добавить|edit|изменить|change|primary|primary category|основная категория)$/i;
    const remaining = lines.filter(value => !labelPattern.test(normalize(value))
      && !ignored.test(value) && !explicitEmptyPattern.test(value));
    const directValue = "value" in control && typeof control.value === "string"
      ? control.value.trim() || undefined
      : undefined;
    if (kind === "list") return remaining.length ? remaining : directValue ? [directValue] : undefined;
    if (kind === "hours" || kind === "long_text") return remaining.length ? remaining.join("\n") : directValue;
    if (kind === "boolean") {
      const last = normalize(remaining.at(-1) || directValue);
      if (/^(?:yes|да|available|доступно)$/.test(last)) return true;
      if (/^(?:no|нет|unavailable|недоступно)$/.test(last)) return false;
      return undefined;
    }
    return remaining[0] || directValue;
  };
  const regionLabel = region => {
    const heading = [...region.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .filter(isVisible)
      .find(element => element.closest('[role="region"]') === region);
    return text(heading) || text(region).split("\n").map(value => value.trim()).find(Boolean) || "";
  };
  const captureRegionValue = (region, kind, labelPattern) => {
    const lines = text(region).split("\n").map(value => value.trim()).filter(Boolean)
      .filter(value => !labelPattern.test(normalize(value)))
      .filter(value => !/^(?:add|добавить|edit|изменить|change)$/i.test(value))
      .filter(value => !explicitEmptyPattern.test(value))
      .filter(value => !/^(?:keyboard shortcuts|map data .+|terms|move left|move right|move up|move down|zoom in|zoom out)$/i.test(value));
    if (!lines.length) return undefined;
    if (kind === "list") return lines;
    if (kind === "hours" || kind === "long_text") return lines.join("\n");
    if (kind === "boolean") {
      const last = normalize(lines.at(-1));
      if (/^(?:yes|да|available|доступно)$/.test(last)) return true;
      if (/^(?:no|нет|unavailable|недоступно)$/.test(last)) return false;
      return undefined;
    }
    return lines[0];
  };
  const capturePanelFields = (root, section) => {
    const result = [];
    const knownControls = new Set();
    const knownRegions = new Set();
    const panelCloseControls = new Set(closeControls(root));
    const controls = [...root.querySelectorAll('button,[role="button"],input,textarea')]
      .filter(isVisible)
      .filter(control => !panelCloseControls.has(control));
    const regions = [...root.querySelectorAll('[role="region"]')]
      .filter(isVisible)
      .filter(region => region.closest('[role="region"]') === region);
    for (const [definitionSection, key, label, kind, pattern] of fieldDefinitions) {
      if (definitionSection !== section) continue;
      const region = regions.find(item => pattern.test(normalize(regionLabel(item))));
      const control = controls.find(item => {
        if (item.matches('[role="tab"]') || item.closest('[role="tablist"]')) return false;
        const lines = controlLines(item).map(normalize);
        return lines.some(line => pattern.test(line)) || pattern.test(accessibleName(item));
      });
      if (control) knownControls.add(control);
      if (region) knownRegions.add(region);
      const source = region || control;
      const value = region
        ? captureRegionValue(region, kind, pattern)
        : control ? captureValue(control, label, kind, pattern) : undefined;
      result.push({
        key, section, label, kind,
        available: Boolean(source),
        readState: source ? capturedReadState(value, source) : "unknown",
        value
      });
    }
    const ignored = /^(?:close|закрыть|more|ещё|еще|about|основное|общая информация|contact|контакты|контактные данные|location|местоположение|hours|часы|часы работы|add|добавить|edit|изменить|save|сохранить|cancel|отмена|back|назад|menu|меню|learn more|подробнее|more info)$/i;
    const seen = new Set(result.map(field => normalize(field.label)));
    if (section === "more") {
      for (const region of regions) {
        if (knownRegions.has(region)) continue;
        const label = regionLabel(region);
        const normalized = normalize(label);
        if (!label || label.length > 120 || ignored.test(normalized) || seen.has(normalized)) continue;
        seen.add(normalized);
        const value = captureRegionValue(region, "list", new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
        result.push({
          key: `${section}.${normalized.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "")}`,
          section,
          label,
          kind: "list",
          available: true,
          readState: capturedReadState(value, region),
          value
        });
      }
    }
    for (const control of controls) {
      if (knownControls.has(control) || control.closest('[role="tablist"]')) continue;
      if (control.closest('[role="region"]')) continue;
      const lines = controlLines(control);
      const label = lines[0] || control.getAttribute("aria-label") || "";
      const normalized = normalize(label);
      const knownSemanticField = fieldDefinitions.some(([definitionSection, _key, _label, _kind, pattern]) =>
        definitionSection === section && pattern.test(normalized));
      if (knownSemanticField) continue;
      if (/^(?:edit|изменить)\s+/i.test(normalized)) continue;
      if (!label || label.length > 120 || ignored.test(normalized) || seen.has(normalized)) continue;
      if (control.matches('input,textarea') && !control.getAttribute("aria-label")) continue;
      // A bare label without a value or «Добавить» is a Google menu option
      // (e.g. the «Добавить другие часы» list), not a profile field.
      if (lines.length <= 1 && !control.matches('input,textarea')) continue;
      seen.add(normalized);
      const tail = normalize(lines.at(-1) || "");
      const booleanValue = /^(?:yes|да|available|доступно)$/.test(tail)
        ? true : /^(?:no|нет|unavailable|недоступно)$/.test(tail) ? false : undefined;
      const remaining = lines.slice(1).filter(value => !ignored.test(normalize(value)));
      const groupedList = /^(?:from the business|accessibility|amenities|children|offerings|parking|payments|planning|service options|от компании|специальные возможности|удобства|дети|предложения|парковка|платежи|планирование|варианты обслуживания)$/.test(normalized);
      const kind = booleanValue !== undefined ? "boolean"
        : section === "hours" ? "hours" : groupedList || remaining.length > 1 ? "list" : "text";
      const value = booleanValue !== undefined ? booleanValue
        : kind === "list" ? remaining : remaining.join("\n") || undefined;
      result.push({
        key: `${section}.${normalized.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "")}`,
        section,
        label,
        kind,
        available: true,
        readState: capturedReadState(value, control),
        value
      });
    }
    return result;
  };
  const selectedTab = tab => tab.getAttribute("aria-selected") === "true"
    || tab.getAttribute("aria-current") === "page";

  async function captureBusinessInfo(base, closeAfter = true) {
    const warnings = [];
    const catalog = [];
    const sectionReadiness = [];
    const completeness = { ...base.completeness, businessInfo: false };
    // A late UI failure must not turn already proven fields into "unknown".
    // This snapshot deliberately never claims Services, because they are read
    // on a different surface.
    const partialResult = blocker => ({
      ...base,
      capturedAt: new Date().toISOString(),
      fieldCatalog: [...catalog],
      warnings: [...new Set([...(base.warnings || []), ...warnings, "business_info_reader_partial"])],
      captureWarnings: [...new Set([...(base.captureWarnings || base.warnings || []), ...warnings, "business_info_reader_partial"])],
      services: [],
      completeness,
      servicesComplete: false,
      blocker,
      diagnostics: { ...(base.diagnostics || {}), sectionReadiness }
    });
    const sections = ["about", "contact", "location", "hours", "more"];
    const sectionLabels = { about: "Основное", contact: "Контакты", location: "Местоположение", hours: "Часы", more: "Ещё" };
    for (const [sectionIndex, section] of sections.entries()) {
        if (runtime.pauseRequested) return partialResult("operator_paused");
        const root = editorRoot("business_info");
        if (!root) return partialResult("business_info_unknown");
        const tab = businessTabCandidates()
          .find(item => root.contains(item.control) && tabPatterns[section].test(item.name))?.control;
        if (!tab) {
          warnings.push(`${section}_tab_missing`);
          sectionReadiness.push({ section, status: "unavailable", reason: "tab_missing", fields: 0 });
          completeness[section] = false;
          continue;
        }
        const safety = safetyStop(text(document.body).slice(0, 12000), surface());
        if (safety) return partialResult(safety);
        tab.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
        tab.click();
        // Google updates aria-selected before it replaces the panel body.  Do
        // not treat that attribute change as a completed navigation: wait for
        // the Business information surface to settle before reading this tab
        // or moving to the next one.
        const settled = await waitForStableSurface("business_info", ACTIVATE_TAB_TIMEOUT_MS, 500);
        if (settled.blocker) {
          sectionReadiness.push({ section, status: "failed", reason: settled.blocker, fields: 0 });
          return partialResult(settled.blocker);
        }
        const activated = await waitFor(() => {
          const currentSurface = surface();
          const stop = safetyStop(text(document.body).slice(0, 12000), currentSurface);
          if (stop) return { blocker: stop };
          if (currentSurface !== "business_info") return { blocker: "business_info_changed" };
          if (!tab.isConnected) return { blocker: "business_info_tab_changed" };
          if (!selectedTab(tab)) return undefined;
          const currentRoot = editorRoot("business_info");
          if (!currentRoot) return { blocker: "business_info_unknown" };
          const fields = capturePanelFields(currentRoot, section);
          return fields.some(field => field.available) ? { fields } : undefined;
        }, ACTIVATE_TAB_TIMEOUT_MS);
        if (activated?.blocker) {
          sectionReadiness.push({ section, status: "failed", reason: activated.blocker, fields: 0 });
          return partialResult(activated.blocker);
        }
        if (!activated) {
          warnings.push(`${section}_activation_unproven`);
          sectionReadiness.push({ section, status: "unavailable", reason: "activation_unproven", fields: 0 });
          completeness[section] = false;
          continue;
        }
        catalog.push(...activated.fields);
        const availableFields = activated.fields.filter(field => field.available);
        completeness[section] = availableFields.length > 0
          && availableFields.every(field => field.readState === "present" || field.readState === "empty");
        sectionReadiness.push({
          section,
          status: completeness[section] ? "read" : "unavailable",
          reason: completeness[section] ? undefined : "field_unproven",
          fields: availableFields.length
        });
        report("capture", `Читаем раздел ${sectionIndex + 1} из ${sections.length}: ${sectionLabels[section]}.`, sectionIndex + 1, sections.length);
    }
    completeness.businessInfo = ["about", "contact", "location", "hours", "more"]
      .every(section => completeness[section] === true);
    const categories = catalog.find(field => field.key === "categories");
    completeness.categories = completeness.about === true
      && Boolean(categories?.available)
      && ["present", "empty"].includes(categories?.readState);
    const attributes = catalog.filter(field => field.section === "more" && field.available);
    completeness.attributes = completeness.more === true
      && attributes.length > 0
      && attributes.every(field => ["present", "empty"].includes(field.readState));
    catalog.push({ key: "services", section: "services", label: "Услуги", kind: "service", available: true, readState: "unknown" });
    warnings.push("services_reader_unproven");
    if (closeAfter) {
      const root = editorRoot("business_info");
      const close = root && closeControls(root)[0];
      if (!close) warnings.push("business_info_close_missing");
      else {
        close.click();
        const closed = await waitFor(() => surface() === "dashboard", CLOSE_EDITOR_TIMEOUT_MS);
        if (!closed) warnings.push("business_info_close_timeout");
      }
    }
    return {
      ...base,
      capturedAt: new Date().toISOString(),
      fieldCatalog: catalog,
      warnings,
      captureWarnings: warnings,
      services: [],
      completeness,
      servicesComplete: false,
      blocker: undefined,
      diagnostics: { ...(base.diagnostics || {}), sectionReadiness }
    };
  }

  const serviceCategoryValues = base => {
    const categories = base.fieldCatalog?.find(field => field.key === "categories")?.value;
    return (Array.isArray(categories) ? categories : typeof categories === "string" ? categories.split(/\n|;/) : [])
      .map(value => String(value).trim()).filter(Boolean);
  };
  const money = value => {
    const normalized = normalize(value);
    if (/^(?:no price|без цены)$/.test(normalized)) return { priceKind: "none", price: undefined, currency: undefined };
    const numeric = String(value || "").replace(/[^\d.,]/g, "").replace(/\s/g, "");
    if (!numeric || !/\d/.test(numeric)) return undefined;
    const dot = numeric.lastIndexOf(".");
    const comma = numeric.lastIndexOf(",");
    const separator = Math.max(dot, comma);
    const tailLength = separator < 0 ? 0 : numeric.length - separator - 1;
    // A final separator followed by one or two digits is a decimal mark;
    // otherwise separators are thousands grouping ("2,400" -> 2400).
    const canonical = separator >= 0 && tailLength > 0 && tailLength <= 2
      ? `${numeric.slice(0, separator).replace(/[.,]/g, "")}.${numeric.slice(separator + 1)}`
      : numeric.replace(/[.,]/g, "");
    const price = Number(canonical);
    if (!Number.isFinite(price)) return undefined;
    const currency = /(?:₽|\brub\b|руб)/i.test(value) ? "RUB"
      : /(?:\$|\busd\b)/i.test(value) ? "USD"
        : /(?:€|\beur\b)/i.test(value) ? "EUR"
          : /(?:£|\bgbp\b)/i.test(value) ? "GBP"
            : /(?:¥|\bjpy\b|\bcny\b)/i.test(value) ? "JPY"
              : /(?:₹|\binr\b)/i.test(value) ? "INR"
                : /(?:₺|\btry\b)/i.test(value) ? "TRY"
                  : /(?:₴|\buah\b)/i.test(value) ? "UAH"
                    : /(?:₸|\bkzt\b)/i.test(value) ? "KZT" : undefined;
    return {
      priceKind: /^(?:from|от)(?:\s|$)/.test(normalized) ? "from" : "fixed",
      price,
      currency
    };
  };
  const serviceScrollRoot = (root, anchor) => {
    // Prefer the closest scrollable ancestor of an actual service row. This
    // avoids scrolling Google's surrounding shell after returning from a
    // detail form, where virtualized rows otherwise disappear from the DOM.
    for (let cursor = anchor?.parentElement; cursor && cursor !== root; cursor = cursor.parentElement) {
      if (root.contains(cursor) && cursor.scrollHeight > cursor.clientHeight + 80) return cursor;
    }
    if (root.scrollHeight > root.clientHeight + 80) return root;
    const candidates = [root, ...root.querySelectorAll("div,section,main")]
      .filter(element => element.scrollHeight > element.clientHeight + 80)
      .filter(element => element === root || root.contains(element))
      .sort((a, b) => (a.scrollHeight - a.clientHeight) - (b.scrollHeight - b.clientHeight));
    return candidates[0] || root;
  };
  const serviceRows = (root, categories) => {
    const creationControl = /(?:add services|add custom service|create your own|don.?t see a service|добавить услуги|добавить услугу|добавить собственную услугу|создать свою услугу)/i;
    const categoryNodes = [...root.querySelectorAll('h2,h3,[role="heading"],div,span')]
      .filter(element => !element.closest('[aria-hidden="true"],[hidden],[inert]')
        && getComputedStyle(element).display !== "none"
        && getComputedStyle(element).visibility !== "hidden")
      .map(element => ({ element, value: text(element).trim(), rect: element.getBoundingClientRect() }))
      .filter(item => item.value && !item.value.includes("\n")
        && categories.some(category => normalize(category) === normalize(item.value)));
    return [...root.querySelectorAll('a,button,[role="button"],[role="link"]')]
      .filter(isVisible)
      .map(control => {
        const lines = controlLines(control);
        // Never treat a creation affordance as a service row.  This remains
        // true even if Google changes the visible copy around the control.
        if (creationControl.test(accessibleName(control)) || creationControl.test(lines.join("\n"))) return undefined;
        const priceLine = lines.find(item => /(?:[$€£¥₹₺₴₸₽]|\b(?:rub|usd|eur|gbp|jpy|cny|inr|try|uah|kzt)\b|no price|без цены)/i.test(item))
          // Some compact Google rows omit the currency symbol but keep a
          // standalone amount (for example, "From 5000").
          || lines.find(item => /^(?:(?:from|от)\s*)?\d[\d\s.,]*$/i.test(item.trim()));
        const parsedPrice = priceLine && money(priceLine);
        const ignored = /^(?:services|edit services|услуги|изменить услуги|add service|add custom service|добавить услугу|добавить собственную услугу|close|закрыть|back|назад|primary category|основная категория)$/i;
        const name = lines.find(item => item.length <= 120 && !ignored.test(item)
          && !/(?:[$€£¥₹₺₴₸₽]|\b(?:rub|usd|eur|gbp|jpy|cny|inr|try|uah|kzt)\b|no price|без цены)/i.test(item));
        // A click is permitted only for a row which already proves that it is
        // a service: name plus price (or Google's explicit "No price").
        // Creation controls have names too, but never this service evidence.
        if (!name || !parsedPrice) return undefined;
        const rowRect = control.getBoundingClientRect();
        const category = categoryNodes
          .filter(item => item.rect.top <= rowRect.top + 2)
          .sort((a, b) => b.rect.top - a.rect.top)[0]?.value;
        // The Services list already exposes each editable row's name,
        // description and price. Reading it directly avoids opening every
        // virtualized detail panel, which is what stalled at row 10/11.
        const description = lines.find(item => item !== name && item !== priceLine
          && item.length <= 300 && !ignored.test(item)
          && !/(?:[$€£¥₹₺₴₸₽]|\b(?:rub|usd|eur|gbp|jpy|cny|inr|try|uah|kzt)\b|no price|без цены)/i.test(item));
        return category ? { control, name, category, priceLine, description } : undefined;
      })
      .filter(Boolean);
  };
  const collectServiceInventory = async (root, categories) => {
    if (!categories.length) return { blocker: "service_category_missing" };
    const initialRows = serviceRows(root, categories);
    const scrollRoot = serviceScrollRoot(root, initialRows[0]?.control);
    const emptyPanelControls = [...root.querySelectorAll('button,a,[role="button"],[role="link"]')]
      .filter(isVisible);
    // Live ru Services editor (26.10.2026) also shows «Меню», «Удалить» for an
    // extra category, «<категория>: добавить ещё услуги» and «Добавить другой
    // вид деятельности». They are editor controls, never unread services.
    const allowedEmptyControl = /^(?:add custom service|добавить собственную услугу|close|закрыть|back|назад|cancel|отмена|save|сохранить|more options|другие параметры|ещё|еще|menu|меню|delete|remove|удалить|add another business category|добавить другой вид деятельности|.+: (?:add more services|добавить ещё услуги|добавить еще услуги))$/;
    const hasAddCustomService = emptyPanelControls
      .some(control => /^(?:add custom service|добавить собственную услугу)$/.test(accessibleName(control)));
    const isCategoryHeaderControl = control => {
      const name = accessibleName(control);
      return categories.some(category => name === normalize(`${category} Primary category`)
        || name === normalize(`${category} Основная категория`));
    };
    const hasUnknownServiceCandidate = emptyPanelControls
      .some(control => !allowedEmptyControl.test(accessibleName(control)) && !isCategoryHeaderControl(control));
    const emptyPanel = /^(?:add services|добавить услуги)$/.test(dialogTitle(root))
      && hasAddCustomService
      && !hasUnknownServiceCandidate
      && serviceRows(root, categories).length === 0;
    if (emptyPanel) return { items: [], scrollRoot, empty: true };
    const original = scrollRoot.scrollTop;
    const found = new Map();
    const descriptors = () => [...found.values()].map(({ control: _control, ...row }) => row);
    let reachedEnd = false;
    try {
      scrollRoot.scrollTop = 0;
      await pause(120);
      for (let attempt = 0; attempt < 100; attempt++) {
        const currentSurface = surface();
        const stop = safetyStop(text(document.body).slice(0, 12000), currentSurface);
        if (stop) return { blocker: stop };
        if (currentSurface !== "services" || !root.isConnected) return { blocker: "services_surface_changed" };
        const rows = serviceRows(root, categories);
        for (const row of rows) {
          const key = normalize(row.name);
          const previous = found.get(key);
          if (previous && (normalize(previous.category) !== normalize(row.category)
            || normalize(previous.priceLine || "") !== normalize(row.priceLine || ""))) {
            return { blocker: "service_row_changed" };
          }
          if (!previous) found.set(key, {
            name: row.name,
            category: row.category,
            priceLine: row.priceLine,
            description: row.description,
            control: row.control
          });
        }
        // A known row must not make an adjacent unrecognized service disappear.
        // Keep independently proven rows, but never label this inventory complete.
        const unknownControl = [...root.querySelectorAll('button,a,[role="button"],[role="link"]')]
          .filter(isVisible)
          .some(control => !rows.some(row => row.control === control)
            && !allowedEmptyControl.test(accessibleName(control))
            && !closeControls(root).includes(control)
            && !isCategoryHeaderControl(control)
            && !/^(?:add services|добавить услуги|add custom service|добавить собственную услугу)$/.test(accessibleName(control)));
        if (unknownControl) return { blocker: "services_scroll_incomplete", items: descriptors() };
        reachedEnd = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2;
        if (reachedEnd) break;
        const before = scrollRoot.scrollTop;
        scrollRoot.scrollTop = Math.min(scrollRoot.scrollHeight, before + Math.max(280, scrollRoot.clientHeight * 0.72));
        await pause(180);
        if (scrollRoot.scrollTop === before) break;
      }
      if (!reachedEnd || found.size === 0) return { blocker: "services_scroll_incomplete", items: descriptors() };
      return {
        items: [...found.values()].map(({ control: _control, ...descriptor }) => descriptor),
        scrollRoot
      };
    } finally {
      scrollRoot.scrollTop = original;
    }
  };
  const controlFieldLabel = control => {
    if (!control) return "";
    const labelledBy = (control.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map(id => text(document.getElementById(id))).filter(Boolean).join(" ");
    const ownLabel = control.id && [...document.querySelectorAll("label")]
      .find(label => label.htmlFor === control.id);
    const fieldset = control.closest("fieldset");
    return normalize(control.getAttribute("aria-label") || labelledBy || text(ownLabel)
      || text(fieldset?.querySelector("legend")) || text(control.closest("label")) || "");
  };
  const findField = (root, selector, pattern) => [...root.querySelectorAll(selector)]
    .filter(isVisible).find(control => pattern.test(controlFieldLabel(control)));
  const locateServiceRow = async (root, categories, expectedName) => {
    const visibleRows = serviceRows(root, categories);
    const scrollRoot = serviceScrollRoot(root, visibleRows[0]?.control);
    const visibleRow = visibleRows.find(item => normalize(item.name) === normalize(expectedName));
    if (visibleRow) return { row: visibleRow, scrollRoot };
    scrollRoot.scrollTop = 0;
    await pause(260);
    let unchangedScrolls = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const stop = safetyStop(text(document.body).slice(0, 12000), surface());
      if (stop) return { blocker: stop };
      const row = serviceRows(root, categories).find(item => normalize(item.name) === normalize(expectedName));
      if (row) return { row, scrollRoot };
      if (scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2) break;
      const before = scrollRoot.scrollTop;
      scrollRoot.scrollTop = Math.min(scrollRoot.scrollHeight, before + Math.max(280, scrollRoot.clientHeight * 0.72));
      // Google virtualizes this list. Let the new window of rows render before
      // deciding that the requested row is gone; one unchanged frame is not a
      // proof that the list ended.
      await pause(280);
      unchangedScrolls = scrollRoot.scrollTop === before ? unchangedScrolls + 1 : 0;
      if (unchangedScrolls >= 3) break;
    }
    return { blocker: "service_row_stale" };
  };
  const readServiceDetails = async (descriptor, categories) => {
    const servicesRoot = editorRoot("services");
    if (!servicesRoot) return { blocker: "services_surface_unknown" };
    const located = await locateServiceRow(servicesRoot, categories, descriptor.name);
    if (located.blocker) return located;
    const creationControl = /(?:add services|add custom service|create your own|don.?t see a service|добавить услуги|добавить услугу|добавить собственную услугу|создать свою услугу)/i;
    if (creationControl.test(accessibleName(located.row.control))
      || creationControl.test(controlLines(located.row.control).join("\n"))) {
      return { blocker: "service_creation_control_rejected" };
    }
    // locateServiceRow already scrolls the proven services container until the row is visible.
    // Calling scrollIntoView here can also scroll the outer Google dialog and hide its title,
    // which would make the same known dialog look unknown on the next item.
    const beforeStop = safetyStop(text(document.body).slice(0, 12000), surface());
    if (beforeStop) return { blocker: beforeStop };
    const listedPrice = money(descriptor.priceLine);
    located.row.control.click();
    const opened = await waitForStableSurface("service_details", ACTIVATE_TAB_TIMEOUT_MS, 300);
    if (opened.blocker) return { blocker: opened.blocker, diagnostics: serviceSurfaceDiagnostics("service_details") };
    const readyRoot = await waitFor(() => {
      const current = surface();
      const stop = safetyStop(text(document.body).slice(0, 12000), current);
      if (stop) return { blocker: stop };
      if (current !== "service_details") return undefined;
      const candidateRoot = editorRoot("service_details");
      if (!candidateRoot) return undefined;
      const inputs = [...candidateRoot.querySelectorAll("input")].filter(isVisible);
      const textareas = [...candidateRoot.querySelectorAll("textarea")].filter(isVisible);
      const hasName = inputs.some(control => normalize(control.value) === normalize(descriptor.name));
      // Description is optional in Google.  Its missing textarea must not
      // prevent the reader from proving this service's name and price.
      return hasName ? { root: candidateRoot } : undefined;
    }, 8000);
    if (readyRoot?.blocker) return { blocker: readyRoot.blocker, diagnostics: serviceSurfaceDiagnostics("service_details") };
    const root = readyRoot?.root || editorRoot("service_details");
    if (!root) return { blocker: "service_details_unknown" };
    const visibleInputs = [...root.querySelectorAll("input")].filter(isVisible);
    const visibleTextareas = [...root.querySelectorAll("textarea")].filter(isVisible);
    const nameControl = findField(root, "input", /^(?:service|услуга)$/)
      || visibleInputs.find(control => Number(control.maxLength) === 120)
      || visibleInputs.find(control => !/^\s*\d+(?:[.,]\d+)?\s*$/.test(String(control.value || "")));
    const descriptionControl = findField(root, "textarea", /^(?:service description|описание услуги)$/)
      || visibleTextareas.find(control => Number(control.maxLength) === 300)
      || (visibleTextareas.length === 1 ? visibleTextareas[0] : undefined);
    const name = String(nameControl?.value || "").trim();
    const description = descriptionControl ? String(descriptionControl.value || "") : undefined;
    const kindControl = findField(root, 'select,[role="combobox"],button,[role="button"]', /^(?:price|цена)(?:\s|$)/)
      || [...root.querySelectorAll('select,[role="combobox"],button,[role="button"],input')]
        .filter(isVisible)
        .find(control => /^(?:from|fixed|no price|от|фиксированная|без цены)$/.test(normalize(control.value || text(control))));
    const amountControl = findField(root, "input", /^(?:service price(?:\s*\([^)]*\))?|цена услуги(?:\s*\([^)]*\))?)$/)
      || visibleInputs.find(control => control !== nameControl && (/^(?:decimal|numeric)$/.test(control.inputMode)
        || /^\s*\d+(?:[.,]\d+)?\s*$/.test(String(control.value || ""))));
    const kindText = `${controlFieldLabel(kindControl)} ${text(kindControl)} ${kindControl?.value || ""}`;
    const amountText = `${controlFieldLabel(amountControl)} ${text(amountControl?.parentElement)} ${amountControl?.value || ""}`;
    const detailPrice = /(?:no price|без цены)/i.test(kindText)
      ? { priceKind: "none", price: undefined, currency: undefined }
      : money(`${/(?:from|от)(?:\s|$)/i.test(kindText) ? "From " : ""}${amountText}`);
    const provenPrice = listedPrice || detailPrice;
    const detailDiagnostics = {
      serviceNameControl: Boolean(nameControl),
      serviceNameMatches: Boolean(nameControl) && normalize(name) === normalize(descriptor.name),
      serviceDescriptionControl: Boolean(descriptionControl),
      servicePriceSource: listedPrice ? "list" : "details",
      servicePriceParsed: Boolean(provenPrice),
      serviceCurrencyParsed: provenPrice?.priceKind === "none" || Boolean(provenPrice?.currency)
    };
    if (!nameControl || !provenPrice || normalize(name) !== normalize(descriptor.name)) {
      return { blocker: "service_details_incomplete", diagnostics: detailDiagnostics };
    }
    const back = [...root.querySelectorAll('button,a,[role="button"]')]
      .filter(isVisible).find(control => backPattern.test(accessibleName(control)));
    if (!back) return { blocker: "service_back_missing" };
    const service = {
      name,
      description,
      category: descriptor.category,
      priceKind: provenPrice.priceKind,
      price: provenPrice.price,
      currency: provenPrice.currency
    };
    back.click();
    const returnStartedAt = Date.now();
    const returnTransition = await waitFor(() => {
      const body = text(document.body).slice(0, 12000);
      if (/captcha|я не робот|unusual traffic/i.test(body)) return { blocker: "captcha" };
      if (/verify it.?s you|verification required|подтвердите|пароль|password|2-step/i.test(body)) {
        return { blocker: "reverification" };
      }
      const discard = discardChangesPrompt();
      if (discard) return { discard };
      // Google may expose the underlying Services list immediately and only
      // show the exact Discard changes prompt a few seconds later. Advancing
      // earlier lets that prompt interrupt the next service.
      return surface() === "services" && Date.now() - returnStartedAt >= 3200
        ? { returned: true }
        : undefined;
    }, ACTIVATE_TAB_TIMEOUT_MS);
    if (returnTransition?.blocker) return { blocker: returnTransition.blocker };
    if (!returnTransition) return { blocker: "service_back_timeout" };
    if (returnTransition?.discard) {
      returnTransition.discard.confirm.click();
    }
    const returned = await waitForStableSurface("services", ACTIVATE_TAB_TIMEOUT_MS, 300);
    return returned.blocker
      ? { ...returned, diagnostics: serviceSurfaceDiagnostics("services") }
      : { service, warning: descriptionControl ? undefined : "service_description_unavailable" };
  };
  const restoreDashboardFromKnownServices = async base => {
    let current = surface();
    if (current === "service_details") {
      const root = editorRoot("service_details");
      const back = root && [...root.querySelectorAll('button,a,[role="button"]')]
        .filter(isVisible).find(control => backPattern.test(accessibleName(control)));
      if (!back) return { blocker: "service_back_missing" };
      back.click();
      const transition = await waitFor(() => {
        const body = text(document.body).slice(0, 12000);
        if (/captcha|я не робот|unusual traffic/i.test(body)) return { blocker: "captcha" };
        if (/verify it.?s you|verification required|подтвердите|пароль|password|2-step/i.test(body)) {
          return { blocker: "reverification" };
        }
        const discard = discardChangesPrompt();
        if (discard) return { discard };
        const next = surface();
        if (next === "unknown") return { blocker: "unknown_dialog" };
        return next === "services" ? { returned: true } : undefined;
      }, ACTIVATE_TAB_TIMEOUT_MS);
      if (!transition || transition.blocker) return { blocker: transition?.blocker || "service_back_timeout" };
      if (transition.discard) transition.discard.confirm.click();
      const returned = await waitForStableSurface("services", ACTIVATE_TAB_TIMEOUT_MS, 300);
      if (returned.blocker) return returned;
      current = surface();
    }
    if (current !== "services") return { blocker: "services_surface_unknown" };
    const root = editorRoot("services");
    const close = root && closeControls(root)[0];
    if (!close) return { blocker: "services_close_missing" };
    close.click();
    const closed = await waitFor(() => surface() === "dashboard", CLOSE_EDITOR_TIMEOUT_MS);
    if (!closed) return { blocker: "services_close_timeout" };
    const after = await inspectStrong();
    return after.blocker || normalize(after.name) !== normalize(base.name)
      || normalize(after.address) !== normalize(base.address)
      ? { blocker: after.blocker || "identity_mismatch" }
      : {};
  };
  const captureServicesSurface = async (base, closeAfter = true) => {
    const root = editorRoot("services");
    if (!root || surface() !== "services") return { ...base, blocker: "services_surface_unknown", servicesComplete: false };
    const categories = serviceCategoryValues(base);
    const inventory = await collectServiceInventory(root, categories);
    if (inventory.blocker && !inventory.items?.length) {
      if (closeAfter) await restoreDashboardFromKnownServices(base);
      return { ...base, blocker: inventory.blocker, blockerStage: "service_inventory", servicesComplete: false };
    }
    const services = [];
    const serviceWarnings = [];
    const completedResult = (extraWarnings = []) => ({
      ...base,
      capturedAt: new Date().toISOString(),
      services,
      completeness: { ...base.completeness, services: true },
      servicesComplete: true,
      serviceProgress: {
        discovered: inventory.items.length,
        attempted: inventory.items.length,
        captured: services.length,
        failed: 0
      },
      warnings: [...new Set([...(base.warnings || []).filter(value => value !== "services_reader_unproven"), ...serviceWarnings, ...extraWarnings])],
      captureWarnings: [...new Set([...(base.captureWarnings || []).filter(value => value !== "services_reader_unproven"), ...serviceWarnings, ...extraWarnings])],
      blocker: undefined
    });
    const partialResult = (blocker, stage, attempted, diagnostics) => {
      const warnings = [...new Set([...(base.warnings || []), "services_reader_partial"])];
      const captureWarnings = [...new Set([...(base.captureWarnings || base.warnings || []), "services_reader_partial"])];
      return {
        ...base,
        capturedAt: new Date().toISOString(),
        blocker,
        blockerStage: stage,
        diagnostics: { ...base.diagnostics, ...diagnostics },
        completeness: { ...base.completeness, services: false },
        servicesComplete: false,
        services: [...services],
        serviceProgress: {
          discovered: inventory.items.length,
          attempted,
          captured: services.length,
          failed: Math.max(0, attempted - services.length)
        },
        warnings,
        captureWarnings
      };
    };
    for (let index = 0; index < inventory.items.length; index++) {
      if (runtime.pauseRequested) {
        if (closeAfter) await restoreDashboardFromKnownServices(base);
        return partialResult("operator_paused", `service_list:${index + 1}`, index, undefined);
      }
      const descriptor = inventory.items[index];
      report("capture", `Читаем строку услуги ${index + 1} из ${inventory.items.length}.`, index + 1, inventory.items.length);
      const price = money(descriptor.priceLine);
      if (!price) {
        if (closeAfter) await restoreDashboardFromKnownServices(base);
        return partialResult("service_list_price_unreadable", `service_list:${index + 1}`, index + 1, undefined);
      }
      services.push({
        name: descriptor.name,
        description: descriptor.description,
        category: descriptor.category,
        priceKind: price.priceKind,
        price: price.price,
        currency: price.currency
      });
    }
    if (inventory.blocker) {
      if (closeAfter) await restoreDashboardFromKnownServices(base);
      return partialResult(inventory.blocker, "service_inventory", services.length, undefined);
    }
    const normalizedNames = services.map(service => normalize(service.name));
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      return partialResult("duplicate_service", "service_inventory", services.length, undefined);
    }
    if (closeAfter) {
      const finalRoot = editorRoot("services");
      const close = finalRoot && closeControls(finalRoot)[0];
      // The data is already proven.  Failing to find the close control only
      // affects the final cleanup, not the completed local service result.
      if (!close) return completedResult(["services_restore_unverified"]);
      close.click();
      const closed = await waitFor(() => surface() === "dashboard", CLOSE_EDITOR_TIMEOUT_MS);
      if (!closed) return completedResult(["services_restore_unverified"]);
      const after = await inspectStrong();
      if (after.blocker || normalize(after.name) !== normalize(base.name)
        || normalize(after.address) !== normalize(base.address)) {
        return completedResult(["services_restore_unverified"]);
      }
    }
    return completedResult();
  };

  async function captureServices(base) {
    runtime.identity = undefined;
    runtime.automationActive = true;
    try {
      const current = await inspectStrong();
      if (current.surface !== "dashboard") return { ...base, blocker: childNavigationBlocker(current, "dashboard_required") };
      if (current.blocker) return { ...base, blocker: current.blocker };
      if (normalize(current.name) !== normalize(base.name) || normalize(current.address) !== normalize(base.address)) {
        return { ...base, blocker: "identity_mismatch" };
      }
      const framesBefore = businessInfoDiagnostics().frames;
      const editServices = findControl([/^edit services$/, /^изменить услуги$/, /^услуги$/]);
      if (!editServices) return { ...base, blocker: "edit_services_missing" };
      const activation = await activateControl(editServices);
      if (!activation.activated) return { ...base, blocker: activation.blocker };
      const openedAt = Date.now();
      const opened = await waitFor(() => {
        const next = surface();
        const stop = safetyStop(text(document.body).slice(0, 12000), next);
        if (stop) return `blocked:${stop}`;
        if (next === "services") return "services";
        const frames = businessInfoDiagnostics().frames;
        return frames > 0 && (frames > framesBefore || Date.now() - openedAt > 4000)
          ? "services_iframe" : undefined;
      }, OPEN_EDITOR_TIMEOUT_MS);
      if (!opened || opened.startsWith("blocked:")) {
        return { ...base, blocker: opened?.split(":")[1] || "services_surface_timeout", servicesComplete: false };
      }
      if (opened === "services_iframe") return { ...base, blocker: "services_iframe", servicesComplete: false };
      return captureServicesSurface(base);
    } finally {
      runtime.identity = undefined;
      runtime.automationActive = false;
    }
  }

  async function captureTemplate() {
    runtime.identity = undefined;
    runtime.automationActive = true;
    runtime.pauseRequested = false;
    try {
      const base = await inspectStrong();
      // Business information is currently rendered inside a visible Google
      // iframe on Search. Its title is not part of the parent document, so
      // detect the already open child before clicking the underlying
      // "Edit profile" button again. The background will prove and read one
      // unambiguous child frame.
      const existingEditor = businessInfoDiagnostics();
      if (base.surface === "dashboard" && existingEditor.frames > 0) {
        return {
          ...base,
          blocker: "business_info_iframe",
          manualBusinessInfo: true,
          skipServices: true,
          diagnostics: { ...base.diagnostics, ...existingEditor }
        };
      }
      // The operator can open Business information directly from the pencil on
      // the Businesses list. When that surface itself proves the identity, read
      // it in place instead of demanding a detour through See your profile.
      // Do not close an editor which the operator opened manually, and do not
      // claim that Services were read from this route.
      if (base.surface === "business_info") {
        if (base.blocker) return base;
        if (base.locale === "unknown") return { ...base, blocker: "unsupported_locale" };
        const capture = await captureBusinessInfo(base, false);
        return {
          ...capture,
          warnings: [...(capture.warnings || []), "business_info_opened_by_operator"],
          captureWarnings: [...(capture.captureWarnings || []), "business_info_opened_by_operator"]
        };
      }
        if (base.surface !== "dashboard") return { ...base, blocker: childNavigationBlocker(base, "dashboard_required") };
        if (base.blocker) return base;
        if (base.locale === "unknown") return { ...base, blocker: "unsupported_locale" };
        const editProfile = findControl([/^edit profile$/, /^изменить профиль$/]);
        if (!editProfile) return { ...base, blocker: "edit_profile_missing" };
        editProfile.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        await pause(80);
        const stop = safetyStop(text(document.body).slice(0, 12000), surface());
        if (stop) return { ...base, blocker: stop };
        if (!editProfile.isConnected || !isVisible(editProfile)
          || editProfile.matches(':disabled,[aria-disabled="true"]')) {
          return { ...base, blocker: "edit_profile_unavailable" };
        }
        const framesBefore = businessInfoDiagnostics().frames;
        editProfile.click();
        const openedAt = Date.now();
        const opened = await waitFor(() => {
          const next = surface();
          const stopped = safetyStop(text(document.body).slice(0, 12000), next);
          if (stopped) return `blocked:${stopped}`;
          if (next === "business_info") return "business_info";
          const diagnostics = businessInfoDiagnostics();
          return diagnostics.frames > 0
            && !diagnostics.businessInfoText
            && (diagnostics.frames > framesBefore || Date.now() - openedAt > 4000)
            ? "business_info_iframe" : undefined;
        }, OPEN_EDITOR_TIMEOUT_MS);
        if (!opened || opened.startsWith("blocked:")) {
          return { ...base, blocker: opened?.split(":")[1] || "business_info_timeout", diagnostics: businessInfoDiagnostics() };
        }
        if (opened === "business_info_iframe") {
          return { ...base, blocker: "business_info_iframe", skipServices: true, diagnostics: businessInfoDiagnostics() };
        }
        return { ...(await captureBusinessInfo(base)) };
    } finally {
      runtime.identity = undefined;
      runtime.automationActive = false;
    }
  }

  // Google scrolls the Businesses list inside its own panel, not the page: climb from a row to the
  // nearest ancestor that actually scrolls, and fall back to the page only when none does.
  const inventoryScrollRoot = () => {
    let cursor = managerRows()[0]?.parentElement;
    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(cursor).overflowY) && cursor.scrollHeight > cursor.clientHeight + 20) return cursor;
      cursor = cursor.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };

  async function scanManagerNetwork() {
    const first = await inspectStrong();
    if (first.blocker && first.blocker !== "manager_selection_required") {
      return { blocker: first.blocker, profiles: [], scrollPositions: 0 };
    }
    if (first.surface !== "businesses") return { blocker: "manager_surface_required", profiles: [], scrollPositions: 0 };
    const initialContext = first.managerContext;
    const root = inventoryScrollRoot();
    const original = root.scrollTop;
    const found = new Map();
    const unresolved = new Map();
    let positions = 0;
    const blocked = blocker => ({
      capturedAt: new Date().toISOString(),
      blocker,
      partial: found.size > 0 || unresolved.size > 0,
      profiles: [...found.values()],
      unresolved: [...unresolved.values()],
      managerContext: { ...initialContext, completeness: "partial" },
      scrollPositions: positions
    });
    const collect = () => {
      for (const item of collectManagerProfiles()) {
        if (found.size >= 200) break;
        found.set(item.data.key, item.data);
      }
      for (const item of collectManagerUnresolved()) unresolved.set(item.key, item);
    };
    try {
      for (let attempt = 0; attempt < 80 && found.size < 200; attempt++) {
        const stop = safetyStop(text(document.body).slice(0, 12000), surface());
        if (stop) return blocked(stop);
        if (surface() !== "businesses") return blocked("manager_surface_changed");
        if ((await readManagerContext()).contextKey !== initialContext.contextKey) return blocked("manager_context_changed");
        collect();
        positions += 1;
        // R-54: 200 is only a safety cap, not the network size — no denominator is shown.
        report("inventory", `Найдено карточек: ${found.size}.`, found.size);
        if (found.size >= 200) break;
        const before = root.scrollTop;
        root.scrollTop = Math.min(root.scrollHeight, before + Math.max(360, root.clientHeight * 0.72));
        await pause(260);
        const afterStop = safetyStop(text(document.body).slice(0, 12000), surface());
        if (afterStop) return blocked(afterStop);
        if (surface() !== "businesses") return blocked("manager_surface_changed");
        if (root.scrollTop === before || root.scrollTop + root.clientHeight >= root.scrollHeight - 2) {
          collect();
          break;
        }
      }
      // R-64: the last collect() after reaching the end may add rows; report the final count.
      report("inventory", `Найдено карточек: ${found.size}.`, found.size);
      const finalStop = safetyStop(text(document.body).slice(0, 12000), surface());
      if (finalStop) return blocked(finalStop);
      if (surface() !== "businesses") return blocked("manager_surface_changed");
      const managerContext = await readManagerContext(found.size + unresolved.size, found.size >= 200);
      if (managerContext.contextKey !== initialContext.contextKey) return blocked("manager_context_changed");
      if (managerLoading()) return blocked("manager_loading");
      // An empty result is not automatically a transport/read failure. A
      // visible Manager row can be intentionally incomplete (for example a
      // business name that contains a number but no address). Keep that
      // read-only result usable and let the UI show an empty inventory; only
      // report inventory_empty when the Manager surface has no row-like
      // content at all.
      if (found.size === 0 && unresolved.size === 0) {
        const rowLike = managerRows().length > 0
          || [...document.querySelectorAll("a,button,[role=button]")]
            .some(control => isVisible(control) && managerProfilePattern.test(accessibleName(control)));
        if (!rowLike && managerContext.completeness !== "confirmed_empty") return blocked("inventory_empty");
      }
      return {
        capturedAt: new Date().toISOString(),
        profiles: [...found.values()],
        unresolved: [...unresolved.values()],
        managerContext,
        scrollPositions: positions,
        truncated: found.size >= 200
      };
    } finally {
      root.scrollTop = original;
    }
  }

  async function readFull() {
    runtime.identity = undefined;
    runtime.automationActive = true;
    try {
      const base = await inspectStrong();
      if (base.surface !== "dashboard") {
        return {
          ...base,
          blocker: childNavigationBlocker(base, "dashboard_required")
        };
      }
      if (base.blocker) return base;
      if (base.locale === "unknown") return { ...base, blocker: "unsupported_locale" };

      // Kept as a narrow identity-only diagnostic. Production read_profile uses
      // background.captureTemplate(), so preview and template transfer share the
      // same full Business information + Services capture.
      return {
        ...base,
        completeness: {
          ...base.completeness,
          businessInfo: false,
          services: false,
          categories: false,
          attributes: false
        },
        services: [],
        servicesComplete: false,
        readWarnings: ["business_info_not_captured", "services_not_captured"],
        blocker: undefined
      };

    } finally {
      runtime.identity = undefined;
      runtime.automationActive = false;
    }
  }

  const descriptionEditorTitlePattern = /^(?:description|edit description|edit business description|описание|изменить описание|изменить описание компании)(?:\s+(?:dialog|window|panel|диалог|окно|панель))?$/i;
  const descriptionFieldPattern = /^(?:description|описание)$/i;
  const normalizeDescriptionPilotText = value => String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  const blockedDescriptionPilot = blocker => ({ status: "blocked", blocker });

  const descriptionPilotContext = async payload => {
    if (!payload || payload.field !== "description"
      || typeof payload.proposedValue !== "string" || !payload.proposedValue.trim()) {
      return blockedDescriptionPilot("description_value_invalid");
    }
    if (!payload.identity?.name || !payload.identity?.address) {
      return blockedDescriptionPilot("identity_incomplete");
    }
    if (location.protocol !== "https:" || !supportedHost) {
      return blockedDescriptionPilot("unsupported_host");
    }
    const body = text(document.body);
    if (/captcha|я не робот|unusual traffic/i.test(body)) return blockedDescriptionPilot("captcha");
    if (/verify it.?s you|verification required|подтвердите|пароль|password|2-step/i.test(body)) {
      return blockedDescriptionPilot("reverification");
    }
    const dialogs = roleElements("dialog");
    const roots = dialogs.filter(dialog => descriptionEditorTitlePattern.test(dialogTitle(dialog)));
    if (roots.length !== 1 || dialogs.length !== 1) return blockedDescriptionPilot("unknown_dialog");
    const root = roots[0];
    const identity = extractIdentity();
    if (!identity.name || !identity.address) return blockedDescriptionPilot("identity_incomplete");
    if (normalize(identity.name) !== normalize(payload.identity.name)
      || normalize(identity.address) !== normalize(payload.identity.address)) {
      return blockedDescriptionPilot("identity_mismatch");
    }
    const controls = [...root.querySelectorAll("textarea,input")]
      .filter(isVisible)
      .filter(control => !control.matches(':disabled,[readonly]'))
      .filter(control => control.tagName === "TEXTAREA" || ["", "text"].includes(String(control.type || "").toLowerCase()))
      .filter(control => descriptionFieldPattern.test(controlFieldLabel(control)));
    if (controls.length !== 1) return blockedDescriptionPilot(
      controls.length ? "description_locator_ambiguous" : "description_locator_missing"
    );
    const control = controls[0];
    const actual = String(control.value ?? "");
    const expected = typeof payload.currentValue === "string" ? payload.currentValue : "";
    if (normalizeDescriptionPilotText(actual) !== normalizeDescriptionPilotText(expected)) {
      return blockedDescriptionPilot("description_current_changed");
    }
    return {
      status: "ready",
      name: identity.name,
      address: identity.address,
      currentValue: actual,
      proposedValue: payload.proposedValue,
      stateHash: await sha256(`${location.href}\n${text(root)}\n${actual}`)
    };
  };

  const applyDescriptionPilot = async payload => {
    const context = await descriptionPilotContext(payload);
    if (context.status !== "ready") return context;
    if (!payload.stateHash || context.stateHash !== payload.stateHash) {
      return blockedDescriptionPilot("state_changed");
    }
    const dialogs = roleElements("dialog");
    const root = dialogs.find(dialog => descriptionEditorTitlePattern.test(dialogTitle(dialog)));
    const controls = root ? [...root.querySelectorAll("textarea,input")]
      .filter(isVisible)
      .filter(item => !item.matches(':disabled,[readonly]'))
      .filter(item => item.tagName === "TEXTAREA" || ["", "text"].includes(String(item.type || "").toLowerCase()))
      .filter(item => descriptionFieldPattern.test(controlFieldLabel(item))) : [];
    if (!root || controls.length !== 1) {
      return { status: "unproven", blocker: controls.length ? "description_locator_ambiguous" : "description_locator_lost" };
    }
    const control = controls[0];
    try {
      const prototype = control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) return { status: "failed", blocker: "description_value_setter_missing" };
      setter.call(control, payload.proposedValue);
      control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: payload.proposedValue }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      const readback = String(control.value ?? "");
      return normalizeDescriptionPilotText(readback) === normalizeDescriptionPilotText(payload.proposedValue)
        ? { status: "matched", readback }
        : { status: "mismatched", readback, blocker: "description_readback_mismatch" };
    } catch (error) {
      return { status: "failed", blocker: `description_insert_failed:${String(error instanceof Error ? error.message : error)}` };
    }
  };

  // Supervised write (Business information). One field at a time, fail-closed:
  // the editor must show the expected current value, exactly one editable
  // control and exactly one Save control must belong to the field editor, and
  // the saved value is read back from the panel before the next field starts.
  const supervisedFieldSpecs = {
    description: {
      section: "about",
      row: /^(?:description|описание|описание компании|business description)$/,
      control: /^(?:description|описание|описание компании|business description|from the business|от компании)$/
    },
    website: {
      section: "contact",
      row: /^(?:website|сайт|веб-сайт)$/,
      control: /^(?:website|сайт|веб-сайт|адрес сайта|website address)$/
    },
    phone: {
      section: "contact",
      row: /^(?:phone number|phone|телефон|номер телефона)$/,
      control: /^(?:primary phone|primary phone number|phone number|phone|основной телефон|основной номер телефона|номер телефона|телефон)$/
    }
  };
  const supervisedSavePattern = /^(?:save|сохранить)$/;
  const supervisedCancelPattern = /^(?:cancel|отмена|отменить)$/;
  // Save failures may be announced page-wide; field validation only counts when
  // it is attached to this field's editor (alert inside the editor scope,
  // aria-describedby/aria-errormessage of the control, or aria-invalid).
  const supervisedSaveFailurePattern = /(?:couldn.?t save|could not save|unable to save|не удалось сохранить)/i;
  const supervisedFieldErrorPattern = /(?:couldn.?t save|could not save|unable to save|something went wrong|enter a valid|(?:is )?not a valid|invalid (?:phone|number|url|website|link|value|address)|не удалось сохранить|что-то пошло не так|введите (?:правильн|корректн|действительн)|(?:недопустим|некорректн|неверн)\S* (?:номер|адрес|ссылк|значени|url|сайт))/i;
  const supervisedPendingPattern = /(?:under review|pending review|being reviewed|in review|на проверке|проверяется|будут проверены|отправлено на проверку)/i;
  const supervisedEditable = control => control.matches("textarea")
    || (control.matches("input") && ["", "text", "url", "tel"].includes(String(control.type || "").toLowerCase()));
  const supervisedText = value => String(value ?? "").replace(/\r\n?/g, "\n")
    .split("\n").map(line => line.replace(/[ \t ]+/g, " ").trim()).join("\n").trim();
  const supervisedSameValue = (key, left, right) => {
    if (key === "phone") {
      const a = String(left ?? "").replace(/\D/g, "");
      const b = String(right ?? "").replace(/\D/g, "");
      return a === b || (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10));
    }
    if (key === "website") {
      const url = value => normalize(value).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
      return url(left) === url(right);
    }
    return normalize(supervisedText(left)) === normalize(supervisedText(right));
  };
  const supervisedTruncated = value => typeof value === "string" && /(?:…|\.\.\.)\s*$/.test(value.trim());
  // A truncated row preview can only be compared as a prefix, and only for text.
  const supervisedPreviewMatches = (key, preview, full) => {
    if (key !== "description" || !supervisedTruncated(preview)) return false;
    const head = normalize(supervisedText(preview).replace(/(?:…|\.\.\.)$/, ""));
    return head.length > 0 && normalize(supervisedText(full)).startsWith(head);
  };
  const supervisedFieldError = (control, scope) => {
    if (control.isConnected && control.getAttribute("aria-invalid") === "true") return "aria-invalid";
    const ids = `${control.getAttribute("aria-describedby") || ""} ${control.getAttribute("aria-errormessage") || ""}`.split(/\s+/).filter(Boolean);
    const described = ids.map(id => control.ownerDocument.getElementById(id)).filter(Boolean);
    const scoped = scope.isConnected ? [...scope.querySelectorAll('[role="alert"],[aria-live="assertive"]')] : [];
    const own = [...described, ...scoped].filter(isVisible).map(text).join("\n");
    if (supervisedFieldErrorPattern.test(own)) return own;
    const page = [...document.querySelectorAll('[role="alert"],[aria-live="assertive"]')].filter(isVisible).map(text).join("\n");
    return supervisedSaveFailurePattern.test(page) ? page : "";
  };
  const supervisedStop = () => {
    const current = surface();
    const stop = safetyStop(text(document.body).slice(0, 12000), current);
    if (stop) return stop;
    return current === "business_info" ? undefined : "business_info_changed";
  };
  const activateBusinessSection = async section => {
    const root = editorRoot("business_info");
    if (!root) return { blocker: "business_info_unknown" };
    const tab = businessTabCandidates()
      .find(item => root.contains(item.control) && tabPatterns[section].test(item.name))?.control;
    if (!tab) return { blocker: `${section}_tab_missing` };
    if (!selectedTab(tab)) {
      tab.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
      tab.click();
    }
    const settled = await waitForStableSurface("business_info", ACTIVATE_TAB_TIMEOUT_MS, 500);
    if (settled.blocker) return { blocker: settled.blocker };
    const ready = await waitFor(() => {
      const stop = supervisedStop();
      if (stop) return { blocker: stop };
      const currentRoot = editorRoot("business_info");
      if (!currentRoot) return { blocker: "business_info_unknown" };
      if (!tab.isConnected || !selectedTab(tab)) return undefined;
      const fields = capturePanelFields(currentRoot, section);
      return fields.some(field => field.available) ? { root: currentRoot, fields } : undefined;
    }, ACTIVATE_TAB_TIMEOUT_MS);
    return ready || { blocker: `${section}_activation_unproven` };
  };
  // The clickable row (or its pencil) for one field. Innermost match wins so a
  // pencil inside a row button is preferred; more than one is ambiguous.
  const supervisedEditTarget = (root, spec) => {
    const panelClose = new Set(closeControls(root));
    const stripVerb = value => value.replace(/^(?:edit|изменить|add|добавить)\s+/, "");
    const candidates = [...root.querySelectorAll('button,[role="button"],a')]
      .filter(isVisible)
      .filter(control => !panelClose.has(control) && !control.closest('[role="tablist"]'))
      .filter(control => !control.matches(':disabled,[aria-disabled="true"]'))
      .filter(control => spec.row.test(stripVerb(accessibleName(control)))
        || controlLines(control).map(normalize).some(line => spec.row.test(line)));
    const regions = [...root.querySelectorAll('[role="region"]')].filter(isVisible)
      .filter(region => spec.row.test(normalize(regionLabel(region))));
    for (const region of regions) {
      const pencils = [...region.querySelectorAll('button,[role="button"]')].filter(isVisible)
        .filter(control => /^(?:edit|изменить)(?:\s|$)/.test(accessibleName(control)));
      if (pencils.length === 1) candidates.push(pencils[0]);
    }
    const unique = [...new Set(candidates)];
    const innermost = unique.filter(control => !unique.some(other => other !== control && control.contains(other)));
    if (innermost.length === 1) return { target: innermost[0] };
    return { blocker: innermost.length ? "field_row_ambiguous" : "field_row_missing" };
  };
  const supervisedEditorControls = spec => [...document.querySelectorAll("textarea,input")]
    .filter(isVisible)
    .filter(control => !control.matches(':disabled,[readonly],[aria-disabled="true"]'))
    .filter(supervisedEditable)
    .filter(control => spec.control.test(controlFieldLabel(control)));
  // The editor scope is the closest ancestor of the control that holds a Save
  // control. Exactly one Save must be there, otherwise the scope is unproven.
  const supervisedEditorScope = control => {
    for (let cursor = control.parentElement; cursor && !cursor.matches("html"); cursor = cursor.parentElement) {
      const saves = [...cursor.querySelectorAll('button,[role="button"]')]
        .filter(isVisible)
        .filter(item => supervisedSavePattern.test(accessibleName(item)));
      if (saves.length === 1) {
        const cancels = [...cursor.querySelectorAll('button,[role="button"]')]
          .filter(isVisible).filter(item => supervisedCancelPattern.test(accessibleName(item)));
        return { scope: cursor, save: saves[0], cancel: cancels.length === 1 ? cancels[0] : undefined };
      }
      if (saves.length > 1) return { blocker: "save_control_ambiguous" };
    }
    return { blocker: "save_control_missing" };
  };
  const supervisedCancel = async editor => {
    if (editor?.cancel?.isConnected && isVisible(editor.cancel)) {
      editor.cancel.click();
      await pause(400);
    }
  };
  const setControlValue = (control, value) => {
    const prototype = control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return false;
    control.focus({ preventScroll: true });
    setter.call(control, value);
    control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  const supervisedFieldValue = (fields, key) => {
    const field = fields.find(item => item.key === key);
    if (!field?.available) return { available: false };
    const value = Array.isArray(field.value) ? field.value.join("\n") : field.value;
    return { available: true, value: typeof value === "string" ? value : undefined, readState: field.readState };
  };

  // Right before Save: the card (URL) must be the one the write started on, and no
  // dialog outside the field editor and the Business information editor may be open.
  const supervisedPreSaveStop = (control, startUrl) => {
    if (location.href !== startUrl) return "state_changed";
    const body = text(document.body).slice(0, 12000);
    if (/captcha|я не робот|unusual traffic/i.test(body)) return "captcha";
    if (/verify it.?s you|verification required|2-step/i.test(body)) return "reverification";
    const root = editorRoot("business_info");
    const foreign = roleElements("dialog").filter(dialog => !dialog.contains(control)
      && dialog !== root && !(root && (root.contains(dialog) || dialog.contains(root))));
    return foreign.length ? "unknown_dialog" : undefined;
  };

  async function applySupervisedField(change, identity, startUrl = location.href) {
    const spec = supervisedFieldSpecs[change.key];
    const result = { key: change.key, proposedValue: change.proposedValue };
    if (!spec) return { ...result, status: "blocked", blocker: "field_not_supported" };
    if (typeof change.proposedValue !== "string" || !supervisedText(change.proposedValue)) {
      return { ...result, status: "blocked", blocker: "empty_value_not_written" };
    }
    // Name is re-proven inside the editor before every field.
    const about = await activateBusinessSection("about");
    if (about.blocker) return { ...result, status: "blocked", blocker: about.blocker };
    const shownName = supervisedFieldValue(about.fields, "businessName");
    if (!shownName.value || normalize(shownName.value) !== normalize(identity.name)) {
      return { ...result, status: "blocked", blocker: shownName.value ? "identity_mismatch_in_editor" : "identity_unproven_in_editor" };
    }
    const section = spec.section === "about" ? about : await activateBusinessSection(spec.section);
    if (section.blocker) return { ...result, status: "blocked", blocker: section.blocker };
    const before = supervisedFieldValue(section.fields, change.key);
    // A truncated preview is only a prefix check here; the full value is proven
    // in the opened editor control before anything is typed.
    if (before.value !== undefined && !supervisedSameValue(change.key, before.value, change.currentValue)
      && !supervisedPreviewMatches(change.key, before.value, change.currentValue)) {
      return { ...result, status: "blocked", blocker: "current_value_changed", observed: before.value };
    }
    if (before.value !== undefined && !supervisedTruncated(before.value)
      && supervisedSameValue(change.key, before.value, change.proposedValue)) {
      return { ...result, status: "unchanged", readback: before.value };
    }
    if (supervisedEditorControls(spec).length) return { ...result, status: "blocked", blocker: "editor_already_open" };
    const located = supervisedEditTarget(section.root, spec);
    if (located.blocker) return { ...result, status: "blocked", blocker: located.blocker };
    located.target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await pause(80);
    const stopBeforeOpen = supervisedStop();
    if (stopBeforeOpen) return { ...result, status: "blocked", blocker: stopBeforeOpen };
    located.target.click();
    const opened = await waitFor(() => {
      const body = text(document.body).slice(0, 12000);
      if (/captcha|я не робот|unusual traffic/i.test(body)) return { blocker: "captcha" };
      if (/verify it.?s you|verification required|2-step/i.test(body)) return { blocker: "reverification" };
      const controls = supervisedEditorControls(spec);
      if (controls.length > 1) return { blocker: "field_control_ambiguous" };
      return controls.length === 1 ? { control: controls[0] } : undefined;
    }, 10000);
    if (!opened) return { ...result, status: "blocked", blocker: "field_editor_not_opened" };
    if (opened.blocker) return { ...result, status: "blocked", blocker: opened.blocker };
    const control = opened.control;
    const editor = supervisedEditorScope(control);
    if (editor.blocker) return { ...result, status: "blocked", blocker: editor.blocker };
    const actual = String(control.value ?? "");
    if (!supervisedSameValue(change.key, actual, change.currentValue ?? "")) {
      await supervisedCancel(editor);
      return { ...result, status: "blocked", blocker: "current_value_changed", observed: actual };
    }
    if (runtime.pauseRequested) {
      await supervisedCancel(editor);
      return { ...result, status: "blocked", blocker: pausedBlocker() };
    }
    if (!setControlValue(control, change.proposedValue)) {
      await supervisedCancel(editor);
      return { ...result, status: "failed", blocker: "value_setter_missing" };
    }
    await pause(250);
    if (!supervisedSameValue(change.key, control.value, change.proposedValue)) {
      await supervisedCancel(editor);
      return { ...result, status: "failed", blocker: "insert_readback_mismatch", observed: String(control.value ?? "") };
    }
    const saveReady = await waitFor(() => editor.save.isConnected
      && !editor.save.matches(':disabled,[aria-disabled="true"]') ? true : undefined, 3000);
    if (!saveReady) {
      await supervisedCancel(editor);
      return { ...result, status: "blocked", blocker: "save_disabled" };
    }
    if (runtime.pauseRequested) {
      await supervisedCancel(editor);
      return { ...result, status: "blocked", blocker: pausedBlocker() };
    }
    // The field must still hold exactly our value: anything else was typed by someone.
    if (!supervisedSameValue(change.key, control.value, change.proposedValue)) {
      await supervisedCancel(editor);
      return { ...result, status: "blocked", blocker: "operator_input", observed: String(control.value ?? "") };
    }
    const stopBeforeSave = supervisedPreSaveStop(control, startUrl);
    if (stopBeforeSave) {
      await supervisedCancel(editor);
      return { ...result, status: "blocked", blocker: stopBeforeSave };
    }
    // Only errors that appear after Save count; a hint shown beforehand does not.
    const errorBeforeSave = supervisedFieldError(control, editor.scope);
    editor.save.click();
    // From here Google may have stored the value whatever happens next: every
    // outcome carries saveClicked so the background always re-reads.
    result.saveClicked = true;
    const saved = await waitFor(() => {
      const body = text(document.body).slice(0, 12000);
      if (/captcha|я не робот|unusual traffic/i.test(body)) return { blocker: "captcha" };
      if (/verify it.?s you|verification required|2-step/i.test(body)) return { blocker: "reverification" };
      const error = supervisedFieldError(control, editor.scope);
      if (error && error !== errorBeforeSave) return { blocker: "google_rejected_value", message: error.slice(0, 240) };
      return !control.isConnected || !isVisible(control) ? { closed: true } : undefined;
    }, 20000);
    if (!saved) return { ...result, status: "unproven", blocker: "save_not_confirmed" };
    if (saved.blocker) {
      if (saved.blocker === "google_rejected_value") await supervisedCancel(editor);
      return { ...result, status: "failed", blocker: saved.blocker, message: saved.message };
    }
    const after = await activateBusinessSection(spec.section);
    if (after.blocker) return { ...result, status: "unproven", blocker: `readback_${after.blocker}` };
    const readback = supervisedFieldValue(after.fields, change.key);
    // "saved" needs the full value. A truncated preview never proves the tail.
    if (supervisedTruncated(readback.value)) {
      return { ...result, status: "unproven", blocker: "readback_truncated", readback: readback.value };
    }
    if (readback.value !== undefined && supervisedSameValue(change.key, readback.value, change.proposedValue)) {
      return { ...result, status: "saved", readback: readback.value };
    }
    const target = supervisedEditTarget(after.root, spec).target;
    const rowText = target ? text(target.closest('[role="region"]') || target) : "";
    if (supervisedPendingPattern.test(rowText)) {
      return { ...result, status: "pending_review", readback: readback.value };
    }
    return { ...result, status: "mismatched", blocker: "saved_readback_mismatch", readback: readback.value };
  }

  async function applySupervisedFields(payload) {
    const changes = Array.isArray(payload?.changes) ? payload.changes : [];
    if (!payload?.identity?.name || !changes.length) return { status: "blocked", blocker: "apply_payload_invalid", fields: [] };
    if (location.protocol !== "https:" || !supportedHost) return { status: "blocked", blocker: "unsupported_host", fields: [] };
    runtime.automationActive = true;
    // «Стоп» pressed before this call must survive it: pauseRequested is reset only when a card is read again.
    runtime.supervisedWriting = true;
    runtime.operatorInput = false;
    const fields = [];
    const startUrl = location.href;
    try {
      const stop = supervisedStop();
      if (stop) return { status: "blocked", blocker: stop, fields };
      for (const [index, change] of changes.entries()) {
        report("apply", `Записываем поле ${index + 1} из ${changes.length}.`, index + 1, changes.length);
        if (runtime.pauseRequested) {
          fields.push({ key: change.key, status: "blocked", blocker: pausedBlocker() });
          break;
        }
        const outcome = await applySupervisedField(change, payload.identity, startUrl);
        fields.push(outcome);
        if (!["saved", "pending_review", "unchanged"].includes(outcome.status)) break;
      }
      const failed = fields.find(field => !["saved", "pending_review", "unchanged"].includes(field.status));
      return {
        status: failed ? (fields.some(field => field.status === "saved" || field.status === "pending_review") ? "partial" : failed.status) : "saved",
        blocker: failed?.blocker,
        fields
      };
    } finally {
      runtime.automationActive = false;
      runtime.supervisedWriting = false;
      document.getElementById("gbp-filler-read-indicator")?.remove();
    }
  }

  async function openBusinessInfoForApply() {
    const base = await inspectStrong();
    if (base.surface === "business_info") return base.blocker ? { blocker: base.blocker } : { opened: "top", name: base.name, address: base.address };
    if (base.surface !== "dashboard") return { blocker: childNavigationBlocker(base, "dashboard_required") };
    if (base.blocker) return { blocker: base.blocker };
    if (businessInfoDiagnostics().frames > 0) return { opened: "iframe", name: base.name, address: base.address };
    const editProfile = findControl([/^edit profile$/, /^изменить профиль$/]);
    if (!editProfile || editProfile.matches(':disabled,[aria-disabled="true"]')) return { blocker: "edit_profile_missing" };
    editProfile.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await pause(80);
    const stop = safetyStop(text(document.body).slice(0, 12000), surface());
    if (stop) return { blocker: stop };
    editProfile.click();
    const opened = await waitFor(() => {
      const next = surface();
      const stopped = safetyStop(text(document.body).slice(0, 12000), next);
      if (stopped) return `blocked:${stopped}`;
      if (next === "business_info") return "top";
      return businessInfoDiagnostics().frames > 0 ? "iframe" : undefined;
    }, OPEN_EDITOR_TIMEOUT_MS);
    if (!opened) return { blocker: "business_info_timeout" };
    if (opened.startsWith("blocked:")) return { blocker: opened.slice(8) };
    return { opened, name: base.name, address: base.address };
  }

  const messageIs = (message, type) => message.type === `${type}:r32`;
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (messageIs(message, "inspect")) {
      inspectStrong().then(reply).catch(error => reply({
        blocker: "reader_failed",
        error: String(error instanceof Error ? error.message : error),
        servicesComplete: false
      }));
      return true;
    }
    if (messageIs(message, "read_full")) {
      readFull().then(reply).catch(error => reply({
        blocker: "reader_failed",
        error: String(error instanceof Error ? error.message : error),
        servicesComplete: false
      }));
      return true;
    }
    if (messageIs(message, "capture_template")) {
      captureTemplate().then(reply).catch(error => reply({
        blocker: "capture_failed",
        error: String(error instanceof Error ? error.message : error),
        servicesComplete: false
      }));
      return true;
    }
    if (messageIs(message, "open_business_info_for_apply")) {
      openBusinessInfoForApply().then(reply).catch(error => reply({
        blocker: "business_info_open_failed",
        error: String(error instanceof Error ? error.message : error)
      }));
      return true;
    }
    if (messageIs(message, "apply_business_fields")) {
      if (surface() !== "business_info") {
        reply({ status: "blocked", blocker: "business_info_not_here", fields: [] });
        return false;
      }
      applySupervisedFields(message.payload).then(reply).catch(error => reply({
        status: "failed",
        blocker: `apply_failed:${String(error instanceof Error ? error.message : error)}`,
        fields: []
      }));
      return true;
    }
    if (messageIs(message, "pause_capture")) {
      runtime.pauseRequested = true;
      reply({ ok: true });
      return false;
    }
    if (messageIs(message, "clear_read_indicator")) {
      document.getElementById("gbp-filler-read-indicator")?.remove();
      reply({ ok: true });
      return false;
    }
    if (messageIs(message, "capture_template_frame")) {
      if (window.top === window || surface() !== "business_info") {
        reply({ blocker: "business_info_frame_not_found", servicesComplete: false });
        return false;
      }
      runtime.automationActive = true;
      captureBusinessInfo(message.base, false).then(reply).catch(error => reply({
        blocker: "capture_failed",
        error: String(error instanceof Error ? error.message : error),
        servicesComplete: false
      })).finally(() => { runtime.automationActive = false; });
      return true;
    }
    if (messageIs(message, "capture_services")) {
      captureServices(message.base).then(reply).catch(error => reply({
        ...message.base,
        blocker: "services_capture_failed",
        error: String(error instanceof Error ? error.message : error),
        servicesComplete: false
      }));
      return true;
    }
    if (messageIs(message, "capture_services_frame")) {
      if (window.top === window) {
        reply({ ...message.base, blocker: "services_frame_not_found", servicesComplete: false });
        return false;
      }
      runtime.automationActive = true;
      waitForStableSurface("services").then(stable => stable.blocker
        ? reply({ ...message.base, blocker: stable.blocker, servicesComplete: false })
        : captureServicesSurface(message.base, false).then(reply).catch(error => reply({
          ...message.base,
          blocker: "services_capture_failed",
          error: String(error instanceof Error ? error.message : error),
          servicesComplete: false
        }))).finally(() => { runtime.automationActive = false; });
      return true;
    }
    if (messageIs(message, "close_business_info_frame")) {
      const root = editorRoot("business_info");
      const close = root && closeControls(root)[0];
      reply({ status: close ? "closing" : "close_missing" });
      if (close) setTimeout(() => close.isConnected && close.click(), 0);
      return false;
    }
    if (messageIs(message, "close_services_frame")) {
      const root = editorRoot("services");
      const close = root && closeControls(root)[0];
      reply({ status: close ? "closing" : "close_missing" });
      if (close) setTimeout(() => close.isConnected && close.click(), 0);
      return false;
    }
    if (messageIs(message, "scan_manager_network")) {
      scanManagerNetwork().then(reply).catch(error => reply({
        blocker: "inventory_failed",
        error: String(error instanceof Error ? error.message : error),
        profiles: [],
        scrollPositions: 0
      }));
      return true;
    }
    if (messageIs(message, "select_manager_group")) {
      runtime.managerGroupNavigation = undefined;
      prepareManagerGroupSelection(message).then(result => {
        reply({ status: result.status, ...(result.blocker ? { blocker: result.blocker } : {}) });
        // Reply before a normal Google navigation can destroy this content script.
        // R-68: the outcome is kept for the background poll (inspect) instead of being dropped.
        if (result.navigate) {
          runtime.managerGroupNavigation = { status: "pending" };
          setTimeout(() => result.navigate()
            .then(outcome => { runtime.managerGroupNavigation = outcome || { status: "clicked" }; })
            .catch(error => {
              runtime.managerGroupNavigation = {
                blocker: "manager_group_navigation_failed",
                error: String(error instanceof Error ? error.message : error)
              };
            }), 0);
        }
      }).catch(() => reply({ status: "blocked", blocker: "manager_group_unavailable" }));
      return true;
    }
    if (messageIs(message, "return_manager")) {
      returnToManager().then(reply).catch(error => reply({
        status: "blocked",
        blocker: String(error instanceof Error ? error.message : error)
      }));
      return true;
    }
    if (messageIs(message, "description_pilot_preflight")) {
      descriptionPilotContext(message).then(reply).catch(error => reply({
        status: "failed", blocker: `description_preflight_failed:${String(error instanceof Error ? error.message : error)}`
      }));
      return true;
    }
    if (messageIs(message, "description_pilot_apply")) {
      applyDescriptionPilot(message).then(reply).catch(error => reply({
        status: "failed", blocker: `description_apply_failed:${String(error instanceof Error ? error.message : error)}`
      }));
      return true;
    }
    if (messageIs(message, "read_profile_strength")) {
      readProfileStrength().then(reply).catch(error => reply({
        state: "blocked",
        blocker: "profile_strength_reader_failed",
        capturedAt: new Date().toISOString(),
        error: String(error instanceof Error ? error.message : error)
      }));
      return true;
    }
    if (messageIs(message, "open_manager_profile")) {
      openManagerProfile(message.candidate).then(reply).catch(error => reply({
        status: "blocked",
        blocker: "manager_open_failed",
        error: String(error instanceof Error ? error.message : error)
      }));
      return true;
    }
  });

  if (location.hostname === "business.google.com") {
    let observedContextKey;
    let contextTimer;
    const observeContext = () => {
      clearTimeout(contextTimer);
      contextTimer = setTimeout(async () => {
        if (surface() !== "businesses") return;
        try {
          const { contextKey } = await readManagerContext();
          if (contextKey === observedContextKey) return;
          observedContextKey = contextKey;
          await chrome.runtime.sendMessage({ type: "manager_context_changed", contextKey });
        } catch { /* A disconnected extension must not change the Google page. */ }
      }, 250);
    };
    new MutationObserver(observeContext).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["aria-selected", "data-value", "selected", "aria-label", "aria-busy", "disabled", "aria-disabled"]
    });
    document.addEventListener("change", observeContext);
    document.addEventListener("input", observeContext);
    observeContext();
  }
})();
