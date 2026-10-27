let approved;
// Panel events: the extension panel listens on runtime messages; a pilot QA panel (localhost) on a port.
const qaPorts = new Set();
function broadcast(message) {
  for (const port of qaPorts) { try { port.postMessage(message); } catch { qaPorts.delete(port); } }
  return chrome.runtime.sendMessage(message);
}
let descriptionPilotApproved;
const CONTENT_PROTOCOL = "r32";
const contentMessage = (type, payload = {}) => ({ type: `${type}:${CONTENT_PROTOCOL}`, ...payload });

const GOOGLE_HOSTS = /^(?:www\.)?google\.(?:com|ru)$/;

const supportedUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (GOOGLE_HOSTS.test(url.hostname) || url.hostname === "business.google.com");
  } catch {
    return false;
  }
};

const sha256 = async value => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(item => item.toString(16).padStart(2, "0")).join("");
};

const tabIdentity = async tab => `${tab.id}:${await sha256(tab.url || "")}`;
const normalizeIdentity = value => String(value || "")
  .normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// A visible editor frame is either discoverable immediately or not usable for
// this pass. Do not leave the operator staring at a 30-second spinner.
const FRAME_DISCOVERY_TIMEOUT_MS = 8000;
const PARENT_RETURN_TIMEOUT_MS = 20000;

// Frame URLs can contain profile-specific path/query data.  The diagnostic
// reports only their Google origin and route family, never the raw URL.
const redactedFrameUrl = value => {
  try {
    const url = new URL(value);
    const route = /^\/local\/business(?:\/|$)/.test(url.pathname)
      ? "/local/business/[redacted]"
      : /^\/search(?:\/|$)/.test(url.pathname)
        ? "/search/[redacted]"
        : "/[redacted]";
    return `${url.origin}${route}`;
  } catch {
    return "invalid-url";
  }
};

const newReadTraceId = () => `read-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;

async function sessionGet(key) {
  const value = await chrome.storage.session.get(key);
  return value[key];
}

async function sessionSet(values) {
  await chrome.storage.session.set(values);
}

// The connected Google tab is the one working tab, kept in the tab group «GYfiller».
// Grouping is a convenience for the operator, never a safety gate: failures are ignored.
const WORK_GROUP_TITLE = "GYfiller";
async function markWorkTab(tab, previousTabId) {
  try {
    if (!chrome.tabGroups?.query || !chrome.tabs.group) return;
    if (previousTabId && previousTabId !== tab.id) {
      const previous = await chrome.tabs.get(previousTabId).catch(() => undefined);
      const previousGroup = previous && previous.groupId !== -1 ? await chrome.tabGroups.get(previous.groupId).catch(() => undefined) : undefined;
      if (previousGroup?.title === WORK_GROUP_TITLE) await chrome.tabs.ungroup(previousTabId);
    }
    // A tab the operator (or a browser tool) already keeps in another group
    // stays there: moving it would break that group's owner.
    const current = await chrome.tabs.get(tab.id).catch(() => tab);
    if (current.groupId !== undefined && current.groupId !== -1) {
      const own = await chrome.tabGroups.get(current.groupId).catch(() => undefined);
      if (own && own.title !== WORK_GROUP_TITLE) return;
    }
    // Queried after ungrouping: a group whose last tab left no longer exists.
    const [group] = await chrome.tabGroups.query({ windowId: tab.windowId, title: WORK_GROUP_TITLE });
    if (group && tab.groupId === group.id) return;
    const groupId = await chrome.tabs.group(group ? { groupId: group.id, tabIds: [tab.id] } : { tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    if (!group) await chrome.tabGroups.update(groupId, { title: WORK_GROUP_TITLE, color: "blue" });
  } catch { /* the tab works the same outside a group */ }
}

async function captureSourceTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !supportedUrl(tab.url)) {
    throw new Error("Откройте карточку Google Business Profile и повторите.");
  }
  const previousTabId = await sessionGet("sourceTabId");
  await sessionSet({ sourceTabId: tab.id, sourceWindowId: tab.windowId });
  await markWorkTab(tab, previousTabId);
  approved = undefined;
  descriptionPilotApproved = undefined; supervisedApproved = undefined;
  broadcast({ type: "approval_stale", reason: "source_binding_changed" }).catch(() => {});
  return tab;
}

async function sourceTab() {
  const sourceTabId = await sessionGet("sourceTabId");
  if (!sourceTabId) throw new Error("Источник Google не подключён. Выберите открытую вкладку через «Подключить Google» в шапке.");
  const tab = await chrome.tabs.get(sourceTabId);
  if (!tab?.id || !supportedUrl(tab.url)) throw new Error("SAFETY_STOP:source_tab_changed");
  return tab;
}

const sourceUrl = value => {
  if (!supportedUrl(value)) return false;
  const url = new URL(value);
  return url.hostname === "business.google.com"
    || /^\/(?:search|local\/business)(?:\/|$)/.test(url.pathname);
};

// Owner 27.10: which Google account a tab belongs to, from the avatar button label in the page corner
// («Аккаунт Google: Имя (почта)» / «Google Account: Name (email)»). Shown in the panel only; never stored.
async function googleAccountLabel(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const label = [...document.querySelectorAll("a[aria-label], button[aria-label], div[aria-label]")]
        .map(element => (element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())
        .find(text => /^(?:Аккаунт Google|Google Account):/i.test(text)) || "";
      const match = /^(?:Аккаунт Google|Google Account):\s*(.*?)\s*\(([^()\s]+@[^()\s]+)\)/i.exec(label);
      return match ? { name: match[1].trim(), email: match[2].trim() } : undefined;
    } });
    return result?.result || undefined;
  } catch {
    return undefined;
  }
}

async function listGoogleSources() {
  const tabs = await chrome.tabs.query({});
  return { tabs: await Promise.all(tabs.filter(tab => tab.id && sourceUrl(tab.url)).map(async tab => {
    const url = new URL(tab.url);
    // R-117: tell identical titles apart — Google profile (u/N or authuser) and kind of page; no query is exposed.
    const account = /\/u\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] ?? /[?&]authuser=(\d+)/.exec(tab.url)?.[1] ?? "0";
    return {
      id: tab.id, title: tab.title || "Google", url: `${url.origin}${url.pathname}`,
      account, kind: url.hostname === "business.google.com" ? "list" : "card", active: Boolean(tab.active),
      // A tab Chrome unloaded after a restart cannot be read; prefer a loaded, recently used copy.
      ready: !tab.discarded && tab.status === "complete", lastAccessed: tab.lastAccessed || 0,
      googleAccount: !tab.discarded && tab.status === "complete" ? await googleAccountLabel(tab.id) : undefined,
      tabHash: await tabIdentity(tab)
    };
  })) };
}

// After a Chrome restart tabs come back unloaded (discarded) and cannot be read. Load the page the way a
// user would by opening it, and wait until it is complete. Only a page that is not loaded is reloaded.
async function ensureTabLoaded(tabId) {
  let tab = await chrome.tabs.get(tabId);
  if (tab.discarded || tab.status === "unloaded") await chrome.tabs.reload(tabId);
  else if (tab.status !== "loading") return tab;
  for (let waited = 0; waited < 25000; waited += 300) {
    await pause(300);
    tab = await chrome.tabs.get(tabId);
    if (!tab.discarded && tab.status === "complete") { await pause(1200); return chrome.tabs.get(tabId); }
  }
  throw new Error("Вкладка Google не загрузилась. Откройте её и выберите снова.");
}

async function connectGoogleSource(input) {
  if (!Number.isInteger(input.tabId) || typeof input.tabHash !== "string") throw new Error("Выберите вкладку Google заново.");
  const tab = await ensureTabLoaded(input.tabId);
  if (!sourceUrl(tab?.url) || await tabIdentity(tab) !== input.tabHash) {
    throw new Error("Вкладка изменилась. Обновите список и выберите её заново.");
  }
  approved = undefined;
  descriptionPilotApproved = undefined;
  const previousTabId = await sessionGet("sourceTabId");
  await sessionSet({ sourceTabId: tab.id, sourceWindowId: tab.windowId });
  await markWorkTab(tab, previousTabId);
  await broadcast({ type: "approval_stale", reason: "source_binding_changed" }).catch(() => {});
  const profile = await inspectSource(false);
  const after = await sourceTab();
  if (after.id !== tab.id || await tabIdentity(after) !== input.tabHash) {
    throw new Error("Вкладка изменилась во время подключения. Выберите источник заново.");
  }
  await broadcast({ type: "source_status_ui", profile }).catch(() => {});
  return profile;
}

// Live 27.10: «Дочитать» turns the Google list page itself and waits until the next rows are shown.
async function managerNextPage() {
  const tab = await sourceTab();
  const before = await inspectSource(false);
  const from = before.managerContext?.page?.from;
  if (before.surface !== "businesses" || !from) return { status: "blocked", blocker: "manager_context_changed" };
  const result = await sendToSource(tab.id, contentMessage("manager_next_page"));
  if (result?.status !== "navigating") return result || { status: "blocked", blocker: "manager_next_page_missing" };
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await pause(300);
    if (await sessionGet("sourceTabId") !== tab.id) return { status: "blocked", blocker: "source_tab_changed" };
    const profile = await inspectSource(false).catch(() => undefined);
    if (profile && ["captcha", "reverification"].includes(profile.blocker)) return { status: "blocked", blocker: profile.blocker };
    if (profile?.managerContext?.page?.from && profile.managerContext.page.from !== from) {
      await broadcast({ type: "source_status_ui", profile }).catch(() => {});
      return { status: "ready", profile };
    }
  }
  return { status: "blocked", blocker: "manager_next_page_timeout" };
}

async function selectManagerGroup(input) {
  if (!input.contextKey || typeof input.label !== "string" || !input.label.trim()
    || (input.groupId !== undefined && typeof input.groupId !== "string")) {
    return { status: "blocked", blocker: "manager_group_unavailable" };
  }
  const tab = await sourceTab();
  const before = await inspectSource(false);
  if (before.surface !== "businesses" || before.managerContext?.contextKey !== input.contextKey) {
    return { status: "blocked", blocker: "manager_context_changed" };
  }
  approved = undefined;
  descriptionPilotApproved = undefined;
  await broadcast({ type: "approval_stale", reason: "manager_context_changed" }).catch(() => {});
  const result = await sendToSource(tab.id, contentMessage("select_manager_group", {
    groupId: input.groupId, label: input.label, contextKey: input.contextKey
  }));
  if (!["ready", "navigating"].includes(result?.status)) return result || { status: "blocked", blocker: "manager_group_unavailable" };
  const deadline = Date.now() + 12000;
  let lastError;
  while (Date.now() < deadline) {
    await pause(250);
    if (await sessionGet("sourceTabId") !== tab.id) return { status: "blocked", blocker: "source_tab_changed" };
    try {
      const profile = await inspectSource(false);
      lastError = undefined;
      if (["captcha", "reverification"].includes(profile.blocker)) return { status: "blocked", blocker: profile.blocker };
      // R-68: the content script reports why its click did not happen; stop waiting and say so.
      const navigationBlocker = profile.managerGroupNavigation?.blocker;
      if (typeof navigationBlocker === "string") {
        await refreshManagerSourceStatus().catch(() => {});
        return { status: "blocked", blocker: navigationBlocker };
      }
      const context = profile.managerContext;
      if (profile.surface === "businesses" && context && context.group.kind !== "unknown"
        && context.group.label === input.label && (!input.groupId || context.group.id === input.groupId)
        && (!profile.blocker || profile.blocker === "manager_selection_required")) {
        await broadcast({ type: "source_status_ui", profile }).catch(() => {});
        return { status: "ready", profile };
      }
    } catch (error) {
      // The selected group may reload the source tab; keep the reason if it never recovers.
      lastError = String(error instanceof Error ? error.message : error);
    }
  }
  await refreshManagerSourceStatus().catch(() => {});
  return { status: "blocked", blocker: "manager_group_navigation_unconfirmed", ...(lastError ? { error: lastError } : {}) };
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

// A profile can finish replacing its DOM just after the popup is opened.
// Re-inject and retry once so a different Chrome profile or a freshly loaded
// Manager page does not fail with the opaque "receiving end" error.
async function sendToSource(tabId, message) {
  await inject(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (firstError) {
    await pause(180);
    await inject(tabId);
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      throw firstError;
    }
  }
}

// Live 27.10: an English Google interface shows the same address transliterated (Курская → Kurskaya).
// Same place only when every number matches and the meaningful words match in Latin (see domain.ts).
const RU_LATIN = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
const ADDRESS_NOISE = new Set(["ulitsa", "ulica", "ul", "street", "st", "prospekt", "pr", "avenue", "per", "pereulok", "lane",
  "dom", "d", "g", "gorod", "city", "oblast", "obl", "region", "kray", "krai", "respublika", "resp", "republic", "rossiya", "russia", "rf",
  "etazh", "floor", "ofis", "office", "pom", "pomeshchenie", "korpus", "k", "str", "stroenie"]);
const addressTokens = value => [...String(value || "").normalize("NFKC").toLocaleLowerCase("ru")].map(c => RU_LATIN[c] ?? c).join("")
  .replace(/['\u2019]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const sameAddressAcrossScripts = (a, b) => {
  if (!a || !b) return false;
  const [ta, tb] = [addressTokens(a), addressTokens(b)];
  const numbers = tokens => tokens.filter(token => /^\d/.test(token));
  const [na, nb] = [numbers(ta), numbers(tb)];
  if (!na.length || !nb.length) return false;
  const [fewN, manyN] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (!fewN.every(n => manyN.includes(n))) return false;
  const words = tokens => tokens.filter(token => !/^\d/.test(token) && token.length >= 3 && !ADDRESS_NOISE.has(token));
  const [wa, wb] = [words(ta), words(tb)];
  const [few, many] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return few.length > 0 && few.every(word => many.some(other => other.slice(0, 5) === word.slice(0, 5)));
};

// Live 27.10: Google Business Profile Manager opens a card from the list in a NEW tab (google.com/search).
// The panel keeps one working tab: it moves that card into the source tab, closes the extra tab and
// remembers the list URL so «return to the list» works after the content script was reloaded.
async function openManagerProfileFollowingNewTab(tab, candidate) {
  await sessionSet({ managerReturnUrl: tab.url });
  let onCreated;
  const newTab = new Promise(resolve => {
    onCreated = created => { if (created.openerTabId === tab.id) resolve(created); };
    chrome.tabs.onCreated?.addListener(onCreated);
  });
  const inPlace = sendToSource(tab.id, contentMessage("open_manager_profile", { candidate }))
    .catch(error => ({ status: "blocked", blocker: "manager_open_failed", error: String(error) }));
  try {
    const first = await Promise.race([inPlace.then(result => ({ inPlace: result })), newTab.then(created => ({ created }))]);
    if (first.inPlace) return first.inPlace;
    let created = first.created;
    for (let waited = 0; (!created.url || created.url === "about:blank") && !created.pendingUrl && waited < 10000; waited += 250) {
      await pause(250);
      created = await chrome.tabs.get(created.id).catch(() => created);
    }
    const url = created.pendingUrl || created.url;
    if (!sourceUrl(url)) return { status: "blocked", blocker: "manager_open_failed" };
    await chrome.tabs.remove(created.id).catch(() => {});
    await chrome.tabs.update(tab.id, { url });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await pause(400);
      const profile = await inspectSource(false).catch(() => undefined);
      if (profile && ["captcha", "reverification"].includes(profile.blocker)) return { status: "blocked", blocker: profile.blocker };
      if (profile?.name && profile.address) {
        const [shown, wanted] = [normalizeIdentity(profile.name), normalizeIdentity(candidate?.name)];
        // Google may show only the brand part of a long title in the card header (same rule as the panel: >= 5 chars, contained).
        const sameName = shown === wanted || (Math.min(shown.length, wanted.length) >= 5 && (wanted.includes(shown) || shown.includes(wanted)));
        const sameAddress = normalizeIdentity(profile.address) === normalizeIdentity(candidate?.address) || sameAddressAcrossScripts(profile.address, candidate?.address);
        if (!sameName || !sameAddress) return { status: "blocked", blocker: "manager_open_identity_mismatch" };
        // The name and address render before the card buttons: wait for «Edit profile» so the read does not start too early.
        for (let waited = 0; waited < 10000; waited += 400) {
          const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => [...document.querySelectorAll("button,a,[role=button]")]
            .some(element => /^(?:edit profile|изменить профиль)$/i.test((element.innerText || "").trim()) && element.getBoundingClientRect().width > 0) }).catch(() => [{}]);
          if (probe?.result) break;
          await pause(400);
        }
        return { status: "ready" };
      }
    }
    return { status: "blocked", blocker: "manager_open_timeout" };
  } finally {
    chrome.tabs.onCreated?.removeListener(onCreated);
  }
}

async function returnToManager(tab) {
  const response = await sendToSource(tab.id, contentMessage("return_manager")).catch(() => undefined);
  const remembered = await sessionGet("managerReturnUrl");
  const managerUrl = response?.status === "return_ready" ? response.managerUrl : remembered;
  let parsed;
  try { parsed = new URL(managerUrl); } catch { return { status: "blocked", blocker: "manager_return_unproven" }; }
  if (parsed.hostname !== "business.google.com"
    || !/\/locations(?:[/?]|$)/.test(parsed.pathname)) {
    return { status: "blocked", blocker: "manager_return_unproven" };
  }
  // The background owns the reload: a content script can disappear during SPA
  // navigation, while the source-tab binding and its identity remain intact.
  await chrome.tabs.update(tab.id, { url: managerUrl });
  const deadline = Date.now() + PARENT_RETURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await pause(300);
    try {
      const snapshot = await inspectSource(false);
      if (snapshot.surface === "businesses"
        && (!snapshot.blocker || snapshot.blocker === "manager_selection_required")) return { status: "ready" };
      if (snapshot.blocker === "captcha" || snapshot.blocker === "reverification") {
        return { status: "blocked", blocker: snapshot.blocker };
      }
    } catch {
      // The new content script may not be ready yet; retry until deadline.
    }
  }
  return { status: "blocked", blocker: "manager_return_timeout" };
}

async function businessEditorFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  return frames
    // Google may alter the editor path while retaining its own origin. Every
    // candidate is still structurally probed and then targeted by frameId;
    // we never inject with allFrames or accept a frame on URL alone.
    .filter(frame => frame.frameId !== 0 && supportedUrl(frame.url || ""))
    .map(frame => ({ frameId: frame.frameId, url: redactedFrameUrl(frame.url || "") }));
}

async function businessEditorFrameIds(tabId) {
  return (await businessEditorFrames(tabId)).map(frame => frame.frameId);
}

async function injectAllFrames(tabId) {
  const frameIds = await businessEditorFrameIds(tabId);
  const injected = await Promise.all(frameIds.map(async frameId => {
    try {
      await injectFrame(tabId, frameId);
      return frameId;
    } catch {
      return undefined;
    }
  }));
  return injected.filter(frameId => frameId !== undefined);
}

async function clearReadIndicators(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  await Promise.all((frames.length ? frames : [{ frameId: 0 }]).map(frame =>
    chrome.tabs.sendMessage(tabId, contentMessage("clear_read_indicator"), { frameId: frame.frameId }).catch(() => undefined)
  ));
}

function probeBusinessInfoFrame() {
      const normalize = value => String(value || "")
        .normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
      const visible = element => {
        if (!element || element.closest('[aria-hidden="true"],[hidden],[inert]')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) !== 0
          && rect.width > 1 && rect.height > 1
          && rect.bottom > 0 && rect.right > 0
          && rect.top < innerHeight && rect.left < innerWidth;
      };
      const tabNames = [...document.querySelectorAll('[role="tab"]')]
        .filter(visible)
        .map(element => normalize(element.getAttribute("aria-label") || element.textContent))
        .map(value => value.replace(/\s+(?:tab|вкладка)(?:\s+\d+\s+(?:of|из)\s+\d+)?$/, ""));
      const expectedTabs = [
        /^(?:about|основное|о компании|общая информация)$/,
        /^(?:contact|контакты|контактные данные)$/,
        /^(?:location|местоположение)$/,
        /^(?:hours|часы|часы работы)$/,
        /^(?:more|ещё|еще)$/
      ];
      const knownTabs = expectedTabs.filter(pattern => tabNames.some(name => pattern.test(name))).length;
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      // Google Search currently renders this editor in an iframe whose title is
      // a styled div rather than a semantic heading or role=dialog.  Keep the
      // frame probe strict (all five tabs and one close control), but accept
      // that accessible title shape so the same panel can be read in-frame.
      const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"],div,span')]
        .filter(visible).map(element => normalize(element.textContent));
      const titled = headings.some(value => /^(?:business information|business info|сведения о компании|информация о компании)$/.test(value));
      const closeControls = [...document.querySelectorAll('button,[role="button"]')]
        .filter(visible)
        .filter(element => /^(?:close|закрыть)(?:\s+(?:dialog|window|panel|диалог|окно|панель))?$/.test(
          normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent)
        )).length;
      return {
        businessInfo: window.top !== window
          && dialogs.length <= 1
          && knownTabs === 5
          && closeControls === 1
          && titled,
        knownTabs,
        closeControls,
        dialogs: dialogs.length,
        titled
      };
}

function businessInfoFrameReason(result) {
  if (!result) return "probe_unavailable";
  if (result.businessInfo === true) return "candidate";
  if (!result.titled) return "title_missing";
  if (result.knownTabs < 5) return "tabs_incomplete";
  if (result.closeControls !== 1) return "close_control_unproven";
  if (result.dialogs > 1) return "dialog_ambiguous";
  return "structure_unrecognized";
}

function businessInfoFrameTrace(frames, probes) {
  const byFrameId = new Map(probes.map(probe => [probe.frameId, probe.result]));
  return frames.slice(0, 12).map(frame => {
    const result = byFrameId.get(frame.frameId);
    return {
      frameId: frame.frameId,
      url: frame.url,
      inspected: Boolean(result),
      knownTabs: result?.knownTabs ?? 0,
      closeControls: result?.closeControls ?? 0,
      dialogs: result?.dialogs ?? 0,
      titled: result?.titled === true,
      reason: businessInfoFrameReason(result)
    };
  });
}

function addBusinessInfoReaderTrace(frameTrace, attempts) {
  return frameTrace.map(frame => {
    const result = attempts.find(attempt => attempt.frameId === frame.frameId)?.result;
    if (!result || result.error) return frame;
    const readerFields = (result.fieldCatalog || []).filter(field =>
      field?.available === true && field.readState !== "unknown"
    ).length;
    const readerSections = Object.entries(result.completeness || {})
      .filter(([section]) => ["about", "contact", "location", "hours", "more"].includes(section))
      .filter(([, complete]) => complete === true)
      .map(([section]) => section);
    return {
      ...frame,
      readerBlocker: result.blocker || (result.completeness?.businessInfo === true ? "complete" : "incomplete"),
      readerFields,
      readerSections
    };
  });
}

function probeServicesFrame() {
  const normalize = value => String(value || "")
    .normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
  const visible = element => {
    if (!element || element.closest('[aria-hidden="true"],[hidden],[inert]')) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) !== 0
      && rect.width > 1 && rect.height > 1
      && rect.bottom > 0 && rect.right > 0
      && rect.top < innerHeight && rect.left < innerWidth;
  };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  if (window.top === window) return { services: false, dialogs: dialogs.length };
  // Some Google Search embeds render Services in a semantic panel rather than
  // in the only role=dialog node.  Probe the visible document in that case,
  // but still require the observed Services structure below.
  const dialog = dialogs.length === 1 ? dialogs[0] : document.body;
  const titles = [
    dialog.getAttribute("aria-label"),
    ...[...dialog.querySelectorAll('h1,h2,h3,[role="heading"],div,span')]
      .filter(visible)
      .map(element => ({ element, value: normalize(element.textContent) }))
      .filter(({ element, value }) => value
        && (element.matches('h1,h2,h3,[role="heading"]')
          || (![...element.children].some(child => normalize(child.textContent) === value)
            && element.getBoundingClientRect().height <= 96)))
      .map(({ value }) => value)
  ].map(normalize).filter(Boolean);
  const titled = titles.some(value => /^(?:services|edit services|услуги|изменить услуги|редактировать услуги)$/.test(value));
  const closeControls = [...dialog.querySelectorAll('button,[role="button"]')]
    .filter(visible)
    .filter(element => /^(?:close|закрыть)(?:\s+(?:dialog|window|panel|диалог|окно|панель))?$/.test(
      normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent)
    )).length;
  const hasCategory = [...dialog.querySelectorAll('h2,h3,[role="heading"],div,span')]
    .filter(visible)
    .some(element => /^(?:primary category|основная категория)$/.test(normalize(element.textContent)));
  // Some Search variants do not expose "Primary category" as a separate
  // node. A visible clickable row with a price is equally strong evidence of
  // the Services panel, for both "From ₽…" and fixed "₽…" prices.
  const serviceRows = [...dialog.querySelectorAll('button,a,[role="button"],[role="link"]')]
    .filter(visible)
    .filter(element => /(?:[$€£¥₹₺₴₸₽]|\b(?:rub|usd|eur|gbp|jpy|cny|inr|try|uah|kzt)\b|no price|без цены)/i
      .test(element.innerText || element.textContent || ""));
  return {
    services: titled && closeControls >= 1 && (hasCategory || serviceRows.length > 0),
    closeControls,
    dialogs: dialogs.length,
    titled,
    hasCategory,
    serviceRows: serviceRows.length
  };
}

async function probeBusinessInfoFrames(tabId) {
  const frames = await businessEditorFrames(tabId);
  const probes = await Promise.all(frames.map(async ({ frameId }) => {
    try {
      return await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: probeBusinessInfoFrame
      });
    } catch {
      return [];
    }
  }));
  return { frames, probes: probes.flat() };
}

async function probeServicesFrames(tabId) {
  const frameIds = await businessEditorFrameIds(tabId);
  const probes = await Promise.all(frameIds.map(async frameId => {
    try {
      return await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: probeServicesFrame
      });
    } catch {
      return [];
    }
  }));
  return probes.flat();
}

async function injectFrame(tabId, frameId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ["content.js"]
  });
}

async function inspectSource(full = false) {
  const tab = await sourceTab();
  const snapshot = await sendToSource(tab.id, contentMessage(full ? "read_full" : "inspect"));
  if (!snapshot || snapshot.error) throw new Error(snapshot?.error || "Google не вернул состояние карточки.");
  return {
    ...snapshot,
    sourceTabId: tab.id,
    tabHash: await tabIdentity(tab),
    mode: "browser"
  };
}

async function captureTemplate({ includeServices = false } = {}) {
  const tab = await sourceTab();
  let capture = await sendToSource(tab.id, contentMessage("capture_template"));
  if (!capture || capture.error) throw new Error(capture?.error || "Google не вернул структуру карточки.");
  if (capture.blocker === "business_info_iframe") {
    const frameTraceId = newReadTraceId();
    const base = {
      name: capture.name,
      address: capture.address,
      city: capture.city,
      locale: capture.locale,
      theme: capture.theme,
      surface: "business_info",
      automation: "controlled_dom",
      stateHash: capture.stateHash,
      completeness: capture.completeness,
      servicesComplete: false,
      manualBusinessInfo: capture.manualBusinessInfo === true
    };
    let frameIds = [];
    let complete = [];
    let partial = [];
    let probedFrames = 0;
    let frameTrace = [];
    let ambiguousProbe = false;
    const frameDeadline = Date.now() + FRAME_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < frameDeadline && complete.length === 0) {
      const { frames, probes } = await probeBusinessInfoFrames(tab.id)
        .catch(() => ({ frames: [], probes: [] }));
      frameTrace = businessInfoFrameTrace(frames, probes);
      const matches = probes.filter(item => item.frameId !== 0 && item.result?.businessInfo === true);
      probedFrames = Math.max(probedFrames, probes.filter(item => item.frameId !== 0).length);
      if (matches.length > 1) {
        ambiguousProbe = true;
        break;
      }
      frameIds = matches.length === 1
        ? [matches[0].frameId]
        : await injectAllFrames(tab.id).catch(() => []);
      const attempts = await Promise.all(frameIds.map(async frameId => {
        try {
          await injectFrame(tab.id, frameId);
          const result = await chrome.tabs.sendMessage(
            tab.id,
            contentMessage("capture_template_frame", { base }),
            { frameId }
          );
          return { frameId, result };
        } catch {
          return { frameId, result: undefined };
        }
      }));
      complete = attempts.filter(attempt =>
        attempt.result
        && !attempt.result.error
        && !attempt.result.blocker
        && attempt.result.completeness?.businessInfo === true
      );
      partial = attempts.filter(attempt =>
        attempt.result
        && !attempt.result.error
        && (attempt.result.fieldCatalog || []).some(field =>
          field?.available === true && field.readState !== "unknown"
        )
      );
      frameTrace = addBusinessInfoReaderTrace(frameTrace, attempts);
      if (complete.length === 0 && partial.length !== 1) await pause(300);
      if (partial.length === 1) break;
    }
    const selected = complete.length === 1 ? complete[0] : partial.length === 1 ? partial[0] : undefined;
    if (selected) {
      await chrome.tabs.sendMessage(
        tab.id,
        contentMessage("close_business_info_frame"),
        { frameId: selected.frameId }
      ).catch(() => undefined);
      let parent;
      let sameIdentity = false;
      const parentDeadline = Date.now() + PARENT_RETURN_TIMEOUT_MS;
      while (Date.now() < parentDeadline && !sameIdentity) {
        await pause(200);
        parent = await chrome.tabs.sendMessage(tab.id, contentMessage("inspect")).catch(() => undefined);
        sameIdentity = Boolean(parent
          && !parent.error
          && !parent.blocker
          && normalizeIdentity(parent.name) === normalizeIdentity(capture.name)
          && normalizeIdentity(parent.address) === normalizeIdentity(capture.address));
        const provenDifferentIdentity = parent
          && !parent.error
          && !parent.blocker
          && parent.name
          && parent.address
          && !sameIdentity;
        if (provenDifferentIdentity) break;
      }
      if (sameIdentity) {
        capture = {
          ...selected.result,
          blocker: complete.length === 1 ? undefined : (selected.result.blocker || "business_info_incomplete"),
          diagnostics: {
            ...selected.result.diagnostics,
            frameTraceId,
            framesTried: frameIds.length,
            framesProbed: probedFrames,
            frameTrace
          }
        };
      } else {
        capture = {
          // The iframe already returned independently parsed fields.  Failure
          // to observe its parent closing is a cleanup warning, never grounds
          // for discarding that proven partial Business information capture.
          ...selected.result,
          blocker: "business_info_parent_unverified",
          diagnostics: {
            ...selected.result.diagnostics,
            frameTraceId,
            framesTried: frameIds.length,
            framesProbed: probedFrames,
            frameTrace
          }
        };
      }
    } else {
      capture = {
        ...capture,
        blocker: ambiguousProbe || complete.length > 1
          ? "business_info_iframe_ambiguous"
          : "business_info_iframe_unreadable",
        diagnostics: {
          ...capture.diagnostics,
          frameTraceId,
          framesTried: frameIds.length,
          framesProbed: probedFrames,
          frameTrace
        }
      };
    }
  }
  // Services are a separate surface. A partial Business information read must
  // not discard its own proven fields or prevent an independent Services read.
  const hasProvenBusinessField = (capture.fieldCatalog || []).some(field =>
    field?.available === true && field.readState !== "unknown"
  );
  if (includeServices && capture.blocker !== "operator_paused" && (capture.completeness?.businessInfo === true || hasProvenBusinessField) && !capture.skipServices) {
    const businessCapture = capture;
    const servicesBase = { ...capture, blocker: undefined };
    let services = await chrome.tabs.sendMessage(tab.id, contentMessage("capture_services", { base: servicesBase }));
    if (!services || services.error) {
      services = { blocker: "services_transport_failed", services: [], servicesComplete: false };
    }
    if (services.blocker === "services_iframe") {
      let frameIds = [];
      let complete = [];
      let decisiveFailure;
      let probedFrames = 0;
      let ambiguousProbe = false;
      const frameDeadline = Date.now() + FRAME_DISCOVERY_TIMEOUT_MS;
      while (Date.now() < frameDeadline && complete.length === 0) {
        const probes = await probeServicesFrames(tab.id).catch(() => []);
        const matches = probes.filter(item => item.frameId !== 0 && item.result?.services === true);
        probedFrames = Math.max(probedFrames, probes.filter(item => item.frameId !== 0).length);
        if (matches.length > 1) {
          ambiguousProbe = true;
          break;
        }
        frameIds = matches.length === 1
          ? [matches[0].frameId]
          : await injectAllFrames(tab.id).catch(() => []);
        const attempts = await Promise.all(frameIds.map(async frameId => {
          try {
            await injectFrame(tab.id, frameId);
            const result = await chrome.tabs.sendMessage(
              tab.id,
              contentMessage("capture_services_frame", { base: capture }),
              { frameId }
            );
            return { frameId, result };
          } catch {
            return { frameId, result: undefined };
          }
        }));
        complete = attempts.filter(attempt => attempt.result
          && !attempt.result.error
          && !attempt.result.blocker
          && attempt.result.servicesComplete === true
          && attempt.result.completeness?.services === true);
        // Several Google child frames may answer in parallel.  Keep the
        // partial result which has actually proved the most services instead
        // of arbitrarily taking the first blocked frame (often an unrelated
        // empty iframe).  A later failed row must never erase prior rows.
        const partialAttempts = attempts
          .filter(attempt => attempt.result?.blocker
            && attempt.result.blocker !== "services_frame_not_found")
          .sort((left, right) => (Array.isArray(right.result?.services) ? right.result.services.length : 0)
            - (Array.isArray(left.result?.services) ? left.result.services.length : 0));
        decisiveFailure = partialAttempts[0];
        if (decisiveFailure) break;
        if (complete.length === 0) await pause(300);
      }
      if (complete.length === 1) {
        const selected = complete[0];
        const completedWithRestoreWarning = warning => ({
          ...selected.result,
          warnings: [...new Set([...(selected.result.warnings || []), warning])],
          captureWarnings: [...new Set([...(selected.result.captureWarnings || selected.result.warnings || []), warning])]
        });
        const closing = await chrome.tabs.sendMessage(
          tab.id,
          contentMessage("close_services_frame"),
          { frameId: selected.frameId }
        ).catch(() => ({ status: "close_missing" }));
        if (closing?.status !== "closing") {
          // All service rows were already read and validated inside the frame.
          // Closing its Google UI is cleanup only, not a condition for keeping
          // the local read result.
          services = completedWithRestoreWarning("services_restore_unverified");
        } else {
          let parent;
          let sameIdentity = false;
          const parentDeadline = Date.now() + PARENT_RETURN_TIMEOUT_MS;
          while (Date.now() < parentDeadline && !sameIdentity) {
            await pause(200);
            parent = await chrome.tabs.sendMessage(tab.id, contentMessage("inspect")).catch(() => undefined);
            sameIdentity = Boolean(parent
              && !parent.error
              && !parent.blocker
              && normalizeIdentity(parent.name) === normalizeIdentity(capture.name)
              && normalizeIdentity(parent.address) === normalizeIdentity(capture.address));
            const different = parent && !parent.error && !parent.blocker && parent.name && parent.address && !sameIdentity;
            if (different) break;
          }
          services = sameIdentity
            ? selected.result
            : completedWithRestoreWarning("services_restore_unverified");
        }
      } else if (decisiveFailure) {
        await chrome.tabs.sendMessage(
          tab.id,
          contentMessage("close_services_frame"),
          { frameId: decisiveFailure.frameId }
        ).catch(() => undefined);
        services = {
          ...decisiveFailure.result,
          diagnostics: {
            ...decisiveFailure.result.diagnostics,
            serviceFramesTried: frameIds.length,
            serviceFramesProbed: probedFrames
          }
        };
      } else {
        services = {
          ...capture,
          blocker: ambiguousProbe || complete.length > 1 ? "services_iframe_ambiguous" : "services_iframe_unreadable",
          servicesComplete: false,
          diagnostics: {
            ...capture.diagnostics,
            serviceFramesTried: frameIds.length,
            serviceFramesProbed: probedFrames
          }
        };
      }
    }
    // Services are an optional second read-job. Its failure must not replace
    // the independently proven Business information transaction or turn its
    // partial fields into a global blocker. An incomplete service prefix is
    // retained for diagnostics/current state, but never marked transferable.
    const servicesComplete = services.servicesComplete === true && services.completeness?.services === true;
    const serviceWarning = services.blocker ? `services_partial:${services.blocker}` : undefined;
    capture = {
      ...businessCapture,
      services: Array.isArray(services.services) ? services.services : [],
      servicesComplete,
      completeness: { ...businessCapture.completeness, services: servicesComplete },
      warnings: [...new Set([...(businessCapture.warnings || []), ...(services.warnings || []), serviceWarning].filter(Boolean))],
      captureWarnings: [...new Set([...(businessCapture.captureWarnings || businessCapture.warnings || []), ...(services.captureWarnings || services.warnings || []), serviceWarning].filter(Boolean))]
    };
  }
  const completeCapture = {
    ...capture,
    // A rerendered Google child dialog may omit a collection from its reply.
    // Preserve the proven scalar snapshot, but never send an undefined
    // collection to the workspace or claim that the interrupted section read.
    fieldCatalog: Array.isArray(capture.fieldCatalog) ? capture.fieldCatalog.map(field => {
      if (field?.key !== "services" || !includeServices) return field;
      const services = Array.isArray(capture.services) ? capture.services : [];
      return {
        ...field,
        available: true,
        readState: services.length ? "present" : capture.servicesComplete === true ? "empty" : "unknown",
        value: services.length ? services.map(service => service.name).filter(Boolean) : undefined
      };
    }) : [],
    services: Array.isArray(capture.services) ? capture.services : [],
    warnings: Array.isArray(capture.warnings) ? capture.warnings : [],
    completeness: capture.completeness || {
      identity: false,
      businessInfo: false,
      services: false,
      categories: false,
      attributes: false
    },
    servicesComplete: capture.servicesComplete === true,
    sourceTabId: tab.id,
    tabHash: await tabIdentity(tab),
    mode: "browser",
    automation: "controlled_dom"
  };
  await clearReadIndicators(tab.id);
  return completeCapture;
}

function currentProfileFromCapture(capture) {
  const fields = new Map((capture.fieldCatalog || []).map(field => [field.key, field]));
  const value = key => fields.get(key)?.value;
  const list = key => Array.isArray(value(key))
    ? value(key).map(String).filter(Boolean)
    : typeof value(key) === "string"
      ? value(key).split(/\n|;/).map(item => item.trim()).filter(Boolean)
      : [];
  const payments = {};
  const amenities = {};
  for (const field of capture.fieldCatalog || []) {
    if (field.section !== "more" || field.available !== true) continue;
    const label = normalizeIdentity(field.label);
    const values = (Array.isArray(field.value) ? field.value : [field.value])
      .filter(item => item !== undefined).map(normalizeIdentity);
    if (/^(?:amenities|удобства)$/.test(label)
      && values.some(item => /^(?:has (?:restroom|toilet)|есть туалет)$/.test(item))) {
      amenities["Has restroom"] = true;
    }
    if (/^(?:payments|платежи)$/.test(label)) {
      if (values.includes("not cash-only") || values.includes("не только наличные")) payments["Cash-only"] = false;
      else if (values.includes("cash-only") || values.includes("только наличные")) payments["Cash-only"] = true;
      if (values.includes("accepts credit cards") || values.includes("принимает кредитные карты")) {
        payments["Accepts credit cards"] = true;
      }
      if (values.includes("accepts debit cards") || values.includes("принимает дебетовые карты")) {
        payments["Accepts debit cards"] = true;
      }
    }
  }
  return {
    ...capture,
    description: typeof value("description") === "string" ? value("description") : undefined,
    categories: list("categories"),
    openingDate: typeof value("openingDate") === "string" ? value("openingDate") : undefined,
    phone: typeof value("phone") === "string" ? value("phone") : undefined,
    website: typeof value("website") === "string" ? value("website") : undefined,
    serviceArea: list("serviceArea"),
    hours: typeof value("hours") === "string" ? value("hours") : undefined,
    specialHours: typeof value("specialHours") === "string" ? value("specialHours") : undefined,
    onlineHours: typeof value("onlineHours") === "string" ? value("onlineHours") : undefined,
    payments,
    amenities
  };
}

async function scanManagerNetwork() {
  const tab = await sourceTab();
  const before = await inspectSource(false);
  if (before.surface !== "businesses" || !before.managerContext
    || (before.managerContext.group.kind === "unknown" && before.managerContext.scope !== "current_list")) {
    throw new Error("Выберите список Businesses и подтвердите группу Google перед чтением сети.");
  }
  const inventory = await sendToSource(tab.id, contentMessage("scan_manager_network"));
  if (!inventory || inventory.error) throw new Error(inventory?.error || "Google не вернул список карточек.");
  // A scan is scoped to the observed group/filter/page, never the whole account.
  const contextKey = inventory.managerContext?.contextKey;
  await refreshManagerSourceStatus();
  return {
    ...inventory,
    profiles: (inventory.profiles || []).map(candidate => contextKey
      ? { ...candidate, managerContextKey: contextKey }
      : candidate),
    sourceTabId: tab.id,
    tabHash: await tabIdentity(tab),
    mode: "browser",
    automation: "controlled_dom"
  };
}

async function refreshManagerSourceStatus() {
  const profile = await inspectSource(false);
  await broadcast({ type: "source_status_ui", profile }).catch(() => {});
  return profile;
}

async function preflightDescriptionPilot(payload) {
  if (!payload?.planId || payload?.field !== "description"
    || !payload?.identity?.name || !payload?.identity?.address
    || typeof payload?.currentValue !== "string"
    || typeof payload?.proposedValue !== "string" || !payload.proposedValue.trim()) {
    return { status: "blocked", blocker: "description_pilot_payload_invalid" };
  }
  const tab = await sourceTab();
  if (payload.sourceTabId && payload.sourceTabId !== tab.id) {
    return { status: "blocked", blocker: "source_tab_changed" };
  }
  const result = await sendToSource(tab.id, contentMessage("description_pilot_preflight", payload));
  if (!result || result.error) return { status: "blocked", blocker: result?.blocker || "description_preflight_failed" };
  return {
    ...result,
    sourceTabId: tab.id,
    tabHash: await tabIdentity(tab),
    planId: payload.planId
  };
}

// Supervised write. Disabled until the operator turns it on for this browser
// session; every run needs a fresh preflight and a one-shot approval digest.
const SUPERVISED_FIELDS = ["description", "phone", "website"];
const SUPERVISED_APPROVAL_TTL_MS = 10 * 60 * 1000;
let supervisedApproved;
// Build flag: only `GBP_SUPERVISED_WRITE=1 node scripts/package-extension.mjs` writes BUILD.json {"supervisedWrite": true}; absent/other = release, write unreachable.
const SUPERVISED_WRITE_BUILD = Promise.resolve()
  .then(() => fetch(chrome.runtime.getURL("BUILD.json")))
  .then(response => response.ok ? response.json() : {})
  .then(build => build?.supervisedWrite === true)
  .catch(() => false);
const SUPERVISED_BUILD_BLOCKED = Object.freeze({
  status: "blocked", blocker: "supervised_write_disabled", reason: "release_build",
  enabled: false, error: "SAFETY_STOP:supervised_write_disabled", fields: []
});

async function supervisedWriteEnabled() {
  return await SUPERVISED_WRITE_BUILD && (await sessionGet("supervisedWriteEnabled")) === true;
}

function supervisedChangesValid(changes) {
  return Array.isArray(changes) && changes.length > 0 && changes.length <= SUPERVISED_FIELDS.length
    && new Set(changes.map(change => change?.key)).size === changes.length
    && changes.every(change => SUPERVISED_FIELDS.includes(change?.key)
      && typeof change.currentValue === "string"
      && typeof change.proposedValue === "string"
      && change.proposedValue.trim().length > 0
      && change.proposedValue.length <= 750);
}

async function preflightSupervisedApply(payload) {
  if (!payload?.planId || !payload?.identity?.name || !payload?.identity?.address
    || !supervisedChangesValid(payload.changes)) {
    return { status: "blocked", blocker: "apply_payload_invalid" };
  }
  const tab = await sourceTab();
  if (payload.sourceTabId && payload.sourceTabId !== tab.id) return { status: "blocked", blocker: "source_tab_changed" };
  const snapshot = await sendToSource(tab.id, contentMessage("inspect"));
  if (!snapshot || snapshot.error) return { status: "blocked", blocker: snapshot?.blocker || "inspect_failed" };
  if (snapshot.blocker) return { status: "blocked", blocker: snapshot.blocker };
  if (!["dashboard", "business_info"].includes(snapshot.surface)) return { status: "blocked", blocker: "dashboard_required" };
  if (normalizeIdentity(snapshot.name) !== normalizeIdentity(payload.identity.name)
    || normalizeIdentity(snapshot.address) !== normalizeIdentity(payload.identity.address)) {
    return { status: "blocked", blocker: "identity_mismatch" };
  }
  return {
    status: "ready",
    planId: payload.planId,
    sourceTabId: tab.id,
    tabHash: await tabIdentity(tab),
    name: snapshot.name,
    address: snapshot.address,
    writeEnabled: await supervisedWriteEnabled()
  };
}

async function findBusinessInfoFrame(tabId) {
  const deadline = Date.now() + FRAME_DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { probes } = await probeBusinessInfoFrames(tabId).catch(() => ({ probes: [] }));
    const matches = probes.filter(item => item.frameId !== 0 && item.result?.businessInfo === true);
    if (matches.length > 1) return { blocker: "business_info_frame_ambiguous" };
    if (matches.length === 1) return { frameId: matches[0].frameId };
    await pause(300);
  }
  return { blocker: "business_info_frame_not_found" };
}

const supervisedVerifyValue = (key, actual, proposed) => {
  if (typeof actual !== "string") return false;
  if (key === "phone") {
    const a = actual.replace(/\D/g, "");
    const b = proposed.replace(/\D/g, "");
    return a === b || (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10));
  }
  if (key === "website") {
    const url = value => normalizeIdentity(value).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
    return url(actual) === url(proposed);
  }
  return normalizeIdentity(actual) === normalizeIdentity(proposed);
};

async function applySupervised(envelope) {
  const tab = await sourceTab();
  const opened = await sendToSource(tab.id, contentMessage("open_business_info_for_apply"));
  if (!opened || opened.error || opened.blocker) {
    return { status: "blocked", blocker: opened?.blocker || "business_info_open_failed", fields: [] };
  }
  let frameId = 0;
  if (opened.opened === "iframe") {
    const frame = await findBusinessInfoFrame(tab.id);
    if (frame.blocker) return { status: "blocked", blocker: frame.blocker, fields: [] };
    frameId = frame.frameId;
    await injectFrame(tab.id, frameId);
  } else {
    await inject(tab.id);
  }
  const written = await chrome.tabs.sendMessage(tab.id, contentMessage("apply_business_fields", {
    payload: { identity: envelope.identity, changes: envelope.changes }
  }), { frameId }).catch(error => ({ status: "failed", blocker: `apply_message_failed:${String(error?.message || error)}`, fields: [] }));
  if (frameId !== 0) {
    await chrome.tabs.sendMessage(tab.id, contentMessage("close_business_info_frame"), { frameId }).catch(() => undefined);
    await pause(1500);
  }
  // Once Save was pressed for any field Google may hold the value, whatever the
  // field status says (unproven, failed, mismatched): always re-read then.
  const touched = field => field.saveClicked === true || ["saved", "pending_review"].includes(field.status);
  if (!(written.fields || []).some(touched)) return { ...written, verify: { status: "skipped" } };
  // Verify is an independent full re-read of Business information.
  let verify;
  try {
    const profile = currentProfileFromCapture(await captureTemplate());
    const sameCard = normalizeIdentity(profile.name) === normalizeIdentity(envelope.identity.name)
      && normalizeIdentity(profile.address) === normalizeIdentity(envelope.identity.address);
    const fields = (written.fields || []).filter(touched)
      .map(field => ({
        fieldStatus: field.status,
        key: field.key,
        verified: sameCard && supervisedVerifyValue(field.key, profile[field.key], field.proposedValue),
        observed: typeof profile[field.key] === "string" ? profile[field.key] : undefined
      }));
    verify = {
      status: !sameCard ? "identity_changed" : fields.every(field => field.verified) ? "verified" : "not_yet_visible",
      fields,
      capturedAt: profile.capturedAt
    };
  } catch (error) {
    verify = { status: "read_failed", error: String(error instanceof Error ? error.message : error) };
  }
  // "saved" without an independent confirmation is reported as unverified.
  const status = written.status === "saved" && verify.status !== "verified" ? "unverified" : written.status;
  return { ...written, status, verify };
}

async function openWorkspace() {
  const source = await sourceTab().catch(() => undefined);
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const anchor = source || active;
  const existingId = await sessionGet("workspaceWindowId");
  if (existingId) {
    try {
      await chrome.windows.update(existingId, { focused: true });
      return { ok: true, windowId: existingId, sourceTabId: source?.id };
    } catch {
      await chrome.storage.session.remove("workspaceWindowId");
    }
  }
  const parent = anchor?.windowId
    ? await chrome.windows.get(anchor.windowId)
    : await chrome.windows.getLastFocused();
  const width = Math.max(1080, Math.round((parent.width || 1440) * 0.92));
  const height = Math.max(720, Math.round((parent.height || 900) * 0.92));
  const left = (parent.left || 0) + Math.max(0, Math.round(((parent.width || width) - width) / 2));
  const top = (parent.top || 0) + Math.max(0, Math.round(((parent.height || height) - height) / 2));
  const workspace = await chrome.windows.create({
    url: chrome.runtime.getURL("index.html"),
    type: "popup",
    focused: true,
    width,
    height,
    left,
    top
  });
  if (!workspace?.id) throw new Error("Не удалось открыть рабочее окно.");
  await sessionSet({ workspaceWindowId: workspace.id });
  return { ok: true, windowId: workspace.id, sourceTabId: source?.id };
}

async function focusWorkspace() {
  const workspaceWindowId = await sessionGet("workspaceWindowId");
  if (!workspaceWindowId) return;
  try {
    await chrome.windows.update(workspaceWindowId, { focused: true });
  } catch {
    await chrome.storage.session.remove("workspaceWindowId");
  }
}

async function focusSourcePopup() {
  let tab;
  try {
    tab = await sourceTab();
  } catch {
    return { status: "source_missing" };
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  if (typeof chrome.action.openPopup === "function") {
    try {
      await chrome.action.openPopup({ windowId: tab.windowId });
      return { status: "popup_opened", sourceTabId: tab.id };
    } catch {
      // Some Chromium builds only allow the toolbar click to open the popup.
    }
  }
  return { status: "source_focused", sourceTabId: tab.id };
}

chrome.windows.onRemoved.addListener(async windowId => {
  if (windowId === await sessionGet("workspaceWindowId")) {
    await chrome.storage.session.remove("workspaceWindowId");
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Google can report a main-tab "loading" transition while it opens or
  // closes an embedded editor.  That is an expected part of a read and must
  // not invalidate the local preview.  A real URL change still invalidates
  // any approval envelope.
  if (tabId === await sessionGet("sourceTabId") && changeInfo.url) {
    approved = undefined;
    descriptionPilotApproved = undefined; supervisedApproved = undefined;
    broadcast({ type: "approval_stale", reason: "source_tab_changed" }).catch(() => {});
  }
  // The old snapshot is retained by the workspace, but the current group must
  // be re-read after navigation. SPA-only changes arrive via the observer below.
  if (tabId === await sessionGet("sourceTabId")
    && (changeInfo.url || changeInfo.status === "complete")
    && sourceUrl(changeInfo.url || tab?.url || "")) {
    await refreshManagerSourceStatus().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (tabId === await sessionGet("sourceTabId")) {
    approved = undefined;
    descriptionPilotApproved = undefined; supervisedApproved = undefined;
    await chrome.storage.session.remove(["sourceTabId", "sourceWindowId"]);
    await broadcast({ type: "approval_stale", reason: "source_tab_closed" }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  approved = undefined;
  descriptionPilotApproved = undefined; supervisedApproved = undefined;
  chrome.storage.session.clear();
});

chrome.runtime.onStartup.addListener(() => {
  approved = undefined;
  descriptionPilotApproved = undefined; supervisedApproved = undefined;
  chrome.storage.session.clear();
});

// Chrome throttles timers (down to once a minute) and pauses rendering in a
// hidden tab, so a Google tab covered by the panel window cannot be read or
// written reliably. Long jobs bring the source tab forward first and hand
// focus back to the panel when they finish.
const VISIBLE_SOURCE_JOBS = new Set([
  "read_profile", "capture_template", "scan_network", "read_profile_strength",
  "open_manager_profile", "return_manager", "select_manager_group",
  "preflight_description_pilot", "apply_description_pilot",
  "preflight_supervised_apply", "apply_supervised_fields", "apply_plan"
]);
async function bringSourceForward() {
  try {
    const tab = await sourceTab();
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    await pause(300);
  } catch { /* the job itself reports a missing source */ }
}
async function returnFocus(sender) {
  try {
    if (sender.tab?.id) {
      await chrome.windows.update(sender.tab.windowId, { focused: true });
      await chrome.tabs.update(sender.tab.id, { active: true });
    }
  } catch { /* the panel may have been closed meanwhile */ }
}

const panelListener = (message, sender, reply) => {
  if (!VISIBLE_SOURCE_JOBS.has(message.type)) return routeMessage(message, sender, reply);
  bringSourceForward().then(() => {
    const finish = value => { returnFocus(sender).finally(() => reply(value)); };
    if (routeMessage(message, sender, finish) !== true) returnFocus(sender);
  });
  return true;
};
chrome.runtime.onMessage.addListener(panelListener);
// Pilot live QA only: the manifest key externally_connectable exists only in the pilot build. It lets the
// same panel UI, served from localhost inside a test browser's own tab group, talk to this background.
if (chrome.runtime.getManifest?.().externally_connectable) {
  chrome.runtime.onMessageExternal.addListener(panelListener);
  chrome.runtime.onConnectExternal.addListener(port => {
    qaPorts.add(port);
    port.onDisconnect.addListener(() => qaPorts.delete(port));
  });
}

function routeMessage(message, sender, reply) {
  const respond = promise => {
    promise.then(reply).catch(error => reply({ error: String(error instanceof Error ? error.message : error) }));
    return true;
  };

  if (message.type === "capture_source") return respond(captureSourceTab().then(tab => ({ ok: true, tabId: tab.id })));
  if (message.type === "open_workspace") return respond(openWorkspace());
  if (message.type === "focus_source_popup") return respond(focusSourcePopup());
  if (message.type === "inspect_source") {
    return respond(captureSourceTab().then(async () => {
      const profile = await inspectSource(false);
      await broadcast({ type: "source_status_ui", profile }).catch(() => {});
      return profile;
    }));
  }
  if (message.type === "manager_context_changed") {
    return respond((async () => {
      const sourceTabId = await sessionGet("sourceTabId");
      if (!sender.tab?.id || sender.tab.id !== sourceTabId
        || (sender.frameId !== undefined && sender.frameId !== 0)) return { status: "ignored" };
      // Do not trust the message payload as context evidence. Inspect the bound
      // source again and invalidate even when the new scope is still unknown.
      approved = undefined;
      descriptionPilotApproved = undefined;
      await broadcast({ type: "approval_stale", reason: "manager_context_changed" }).catch(() => {});
      await refreshManagerSourceStatus();
      return { status: "refreshed" };
    })());
  }
  if (message.type === "open_manager_profile") {
    approved = undefined;
    descriptionPilotApproved = undefined; supervisedApproved = undefined;
    return respond((async () => {
      const tab = await sourceTab();
      if (message.candidate?.managerContextKey) {
        const snapshot = await inspectSource(false);
        if (snapshot.surface !== "businesses"
          || (snapshot.managerContext?.group.kind === "unknown" && snapshot.managerContext?.scope !== "current_list")
          || snapshot.managerContext?.contextKey !== message.candidate.managerContextKey) {
          return { status: "blocked", blocker: "manager_context_changed" };
        }
      }
      return openManagerProfileFollowingNewTab(tab, message.candidate);
    })());
  }
  if (message.type === "return_manager") {
    approved = undefined;
    descriptionPilotApproved = undefined; supervisedApproved = undefined;
    return respond((async () => {
      const tab = await sourceTab();
      return returnToManager(tab);
    })());
  }
  if (message.type === "source_status") {
    return respond((async () => {
      const profile = await inspectSource(false);
      return { connected: true, sourceTabId: profile.sourceTabId, profile, googleAccount: await googleAccountLabel(profile.sourceTabId) };
    })());
  }
  if (message.type === "list_google_sources") return respond(listGoogleSources());
  if (message.type === "source_account") return respond(sourceTab().then(tab => googleAccountLabel(tab.id)).then(account => ({ account })).catch(() => ({ account: undefined })));
  if (message.type === "connect_google_source") return respond(connectGoogleSource(message));
  if (message.type === "select_manager_group") return respond(selectManagerGroup(message));
  if (message.type === "api_status") {
    reply({
      mode: "api",
      available: false,
      reason: "Требуются одобренный Google Cloud project и OAuth business.manage."
    });
    return;
  }
  if (message.type === "automation_progress") {
    return respond((async () => {
      const sourceTabId = await sessionGet("sourceTabId");
      if (!sender.tab?.id || sender.tab.id !== sourceTabId) {
        throw new Error("SAFETY_STOP:progress_from_unknown_tab");
      }
      await chrome.runtime.sendMessage({
        type: "automation_progress_ui",
        payload: message.payload
      }).catch(() => {});
      return { ok: true };
    })());
  }
  if (message.type === "read_profile") {
    approved = undefined;
    descriptionPilotApproved = undefined; supervisedApproved = undefined;
    return respond(captureTemplate().then(currentProfileFromCapture));
  }
  if (message.type === "capture_template") {
    approved = undefined;
    descriptionPilotApproved = undefined; supervisedApproved = undefined;
    return respond(captureTemplate({ includeServices: message.includeServices === true }));
  }
  if (message.type === "pause_capture") {
    return respond((async () => {
      const tab = await sourceTab();
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []);
      await Promise.all((frames.length ? frames : [{ frameId: 0 }]).map(async frame => {
        if (frame.frameId !== 0) await injectFrame(tab.id, frame.frameId).catch(() => undefined);
        return chrome.tabs.sendMessage(tab.id, contentMessage("pause_capture"), { frameId: frame.frameId }).catch(() => undefined);
      }));
      return { ok: true };
    })());
  }
  if (message.type === "manager_next_page") return respond(managerNextPage());
  if (message.type === "scan_network") {
    approved = undefined;
    descriptionPilotApproved = undefined; supervisedApproved = undefined;
    return respond(scanManagerNetwork());
  }
  if (message.type === "read_profile_strength") {
    approved = undefined;
    return respond((async () => {
      const tab = await sourceTab();
      const observation = await sendToSource(tab.id, contentMessage("read_profile_strength"));
      if (!observation || observation.error) throw new Error(observation?.error || "Google не вернул статус карточки.");
      return { ...observation, sourceTabId: tab.id, tabHash: await tabIdentity(tab) };
    })());
  }
  if (message.type === "approve_plan") {
    const payload = message.payload;
    if (!payload?.digest || !payload?.planId || !payload?.sourceTabId
      || !payload?.stateHash || !payload?.tabHash || payload?.mode !== "browser"
      || payload?.automation !== "controlled_dom"
      || !payload?.identityFingerprint || !payload?.envelope) {
      reply({ error: "Некорректное подтверждение." });
      return;
    }
    return respond((async () => {
      const calculated = await sha256(JSON.stringify(payload.envelope));
      if (calculated !== payload.digest
        || payload.envelope.planId !== payload.planId
        || payload.envelope.sourceTabId !== payload.sourceTabId
        || payload.envelope.stateHash !== payload.stateHash
        || payload.envelope.tabHash !== payload.tabHash
        || payload.envelope.mode !== payload.mode
        || payload.envelope.automation !== payload.automation
        || payload.envelope.identityFingerprint !== payload.identityFingerprint
        || !payload.envelope.identity?.name
        || !payload.envelope.identity?.address
        || !Array.isArray(payload.envelope.actions)
        || payload.envelope.actions.some(action => !action?.id || !["skip", "add", "replace"].includes(action.action))) {
        throw new Error("SAFETY_STOP:approval_digest_mismatch");
      }
      approved = {
        digest: payload.digest,
        planId: payload.planId,
        sourceTabId: payload.sourceTabId,
        stateHash: payload.stateHash,
        tabHash: payload.tabHash,
        mode: payload.mode,
        automation: payload.automation,
        identityFingerprint: payload.identityFingerprint,
        envelope: payload.envelope,
        approvedAt: Date.now()
      };
      return { ok: true };
    })());
  }
  if (message.type === "preflight_description_pilot") {
    return respond(preflightDescriptionPilot(message.payload));
  }
  if (message.type === "approve_description_pilot") {
    const payload = message.payload;
    if (!payload?.digest || !payload?.envelope) {
      reply({ error: "Некорректное подтверждение Description pilot." });
      return;
    }
    return respond((async () => {
      const envelope = payload.envelope;
      const calculated = await sha256(JSON.stringify(envelope));
      if (calculated !== payload.digest
        || envelope.field !== "description"
        || !envelope.planId
        || !envelope.sourceTabId
        || !envelope.tabHash
        || !envelope.stateHash
        || !envelope.identity?.name
        || !envelope.identity?.address
        || !envelope.identityFingerprint
        || typeof envelope.currentValue !== "string"
        || typeof envelope.proposedValue !== "string"
        || !envelope.proposedValue.trim()) {
        throw new Error("SAFETY_STOP:description_pilot_approval_invalid");
      }
      descriptionPilotApproved = { digest: payload.digest, envelope, approvedAt: Date.now() };
      return { ok: true };
    })());
  }
  if (message.type === "apply_description_pilot") {
    return respond((async () => {
      if (!await SUPERVISED_WRITE_BUILD) { descriptionPilotApproved = undefined; return SUPERVISED_BUILD_BLOCKED; }
      const payload = message.payload;
      const attempt = descriptionPilotApproved;
      descriptionPilotApproved = undefined; supervisedApproved = undefined;
      if (!attempt || attempt.digest !== payload?.digest
        || JSON.stringify(attempt.envelope) !== JSON.stringify(payload?.envelope)
        || Date.now() - attempt.approvedAt > 10 * 60 * 1000) {
        return { status: "blocked", blocker: "approval_stale" };
      }
      if (await sha256(JSON.stringify(payload.envelope)) !== attempt.digest) {
        return { status: "blocked", blocker: "approval_digest_mismatch" };
      }
      const fresh = await preflightDescriptionPilot(attempt.envelope);
      if (fresh.status !== "ready") return { status: "blocked", blocker: fresh.blocker || "description_preflight_failed" };
      if (fresh.sourceTabId !== attempt.envelope.sourceTabId
        || fresh.tabHash !== attempt.envelope.tabHash
        || fresh.stateHash !== attempt.envelope.stateHash
        || normalizeIdentity(fresh.name) !== normalizeIdentity(attempt.envelope.identity.name)
        || normalizeIdentity(fresh.address) !== normalizeIdentity(attempt.envelope.identity.address)
        || fresh.currentValue !== attempt.envelope.currentValue
        || fresh.proposedValue !== attempt.envelope.proposedValue) {
        return { status: "blocked", blocker: "state_changed" };
      }
      const result = await sendToSource(fresh.sourceTabId, contentMessage("description_pilot_apply", attempt.envelope));
      return result?.status ? result : { status: "failed", blocker: "description_apply_failed" };
    })());
  }
  if (message.type === "supervised_write_state") {
    return respond((async () => ({
      available: await SUPERVISED_WRITE_BUILD, enabled: await supervisedWriteEnabled(), fields: SUPERVISED_FIELDS
    }))());
  }
  if (message.type === "set_supervised_write") {
    return respond((async () => {
      // Release build: the write path is unreachable whatever the message says.
      if (!await SUPERVISED_WRITE_BUILD) return SUPERVISED_BUILD_BLOCKED;
      // Session-only: a browser restart always returns to read-only. The phrase
      // is typed by the operator in the panel; it is never sent automatically.
      const enabled = message.enabled === true && message.confirm === "ЗАПИСЬ В GOOGLE";
      await sessionSet({ supervisedWriteEnabled: enabled });
      supervisedApproved = undefined;
      return { enabled };
    })());
  }
  if (message.type === "preflight_supervised_apply") {
    supervisedApproved = undefined;
    return respond(preflightSupervisedApply(message.payload));
  }
  if (message.type === "approve_supervised_apply") {
    const payload = message.payload;
    return respond((async () => {
      if (!await SUPERVISED_WRITE_BUILD) return SUPERVISED_BUILD_BLOCKED;
      const envelope = payload?.envelope;
      if (!payload?.digest || !envelope || await sha256(JSON.stringify(envelope)) !== payload.digest
        || !envelope.planId || !envelope.sourceTabId || !envelope.tabHash
        || !envelope.identity?.name || !envelope.identity?.address
        || !supervisedChangesValid(envelope.changes)) {
        throw new Error("SAFETY_STOP:supervised_approval_invalid");
      }
      if (!await supervisedWriteEnabled()) throw new Error("SAFETY_STOP:supervised_write_disabled");
      supervisedApproved = { digest: payload.digest, envelope, approvedAt: Date.now() };
      return { ok: true };
    })());
  }
  if (message.type === "apply_supervised_fields") {
    return respond((async () => {
      const payload = message.payload;
      const attempt = supervisedApproved;
      supervisedApproved = undefined;
      if (!await SUPERVISED_WRITE_BUILD) return SUPERVISED_BUILD_BLOCKED;
      if (!await supervisedWriteEnabled()) return { status: "blocked", blocker: "supervised_write_disabled", fields: [] };
      if (!attempt || attempt.digest !== payload?.digest
        || JSON.stringify(attempt.envelope) !== JSON.stringify(payload?.envelope)
        || Date.now() - attempt.approvedAt > SUPERVISED_APPROVAL_TTL_MS) {
        return { status: "blocked", blocker: "approval_stale", fields: [] };
      }
      const fresh = await preflightSupervisedApply(attempt.envelope);
      if (fresh.status !== "ready") return { status: "blocked", blocker: fresh.blocker || "preflight_failed", fields: [] };
      if (fresh.sourceTabId !== attempt.envelope.sourceTabId || fresh.tabHash !== attempt.envelope.tabHash) {
        return { status: "blocked", blocker: "state_changed", fields: [] };
      }
      return applySupervised(attempt.envelope);
    })());
  }
  if (message.type === "apply_plan") {
    return respond((async () => {
      const payload = message.payload;
      const attempt = approved;
      approved = undefined;
      if (!attempt
        || attempt.digest !== payload?.digest
        || attempt.planId !== payload?.planId
        || attempt.sourceTabId !== payload?.sourceTabId
        || attempt.stateHash !== payload?.stateHash
        || attempt.tabHash !== payload?.tabHash
        || attempt.mode !== payload?.mode
        || attempt.automation !== payload?.automation
        || attempt.identityFingerprint !== payload?.identityFingerprint
        || Date.now() - attempt.approvedAt > 10 * 60 * 1000) {
        return { status: "blocked", blocker: "approval_stale" };
      }
      if (JSON.stringify(attempt.envelope) !== JSON.stringify(payload?.envelope)
        || await sha256(JSON.stringify(payload?.envelope)) !== attempt.digest) {
        return { status: "blocked", blocker: "approval_digest_mismatch" };
      }
      const approvedEnvelope = attempt;
      const fresh = await inspectSource(true);
      if (fresh.blocker
        || !["ru", "en"].includes(fresh.locale)
        || fresh.surface === "unknown"
        || fresh.completeness?.identity !== true
        || fresh.automation !== "controlled_dom") {
        return { status: "blocked", blocker: fresh.blocker || "fresh_read_incomplete" };
      }
      if (fresh.sourceTabId !== approvedEnvelope.sourceTabId
        || fresh.tabHash !== approvedEnvelope.tabHash
        || fresh.stateHash !== approvedEnvelope.stateHash) {
        return { status: "blocked", blocker: "state_changed" };
      }
      if (normalizeIdentity(fresh.name) !== approvedEnvelope.envelope.identity.name
        || normalizeIdentity(fresh.address) !== approvedEnvelope.envelope.identity.address) {
        return { status: "blocked", blocker: "identity_changed" };
      }
      if (fresh.servicesComplete !== true) {
        return { status: "blocked", blocker: "services_incomplete" };
      }
      return { status: "blocked", blocker: "supervised_pilot_required" };
    })());
  }
}
