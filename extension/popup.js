const state = document.getElementById("state");
const open = document.getElementById("open");
const retry = document.getElementById("retry");
const network = document.getElementById("network");
const connect = document.getElementById("connect");
const bound = document.getElementById("bound");
const subtitle = document.getElementById("subtitle");
const api = document.getElementById("api");
const blockers = {
  unsupported_host: "Откройте нужную карточку в Google Search или Google Business Profile.",
  unsupported_locale: "Поддерживаются русский и английский интерфейсы Google.",
  captcha: "Завершите CAPTCHA вручную и проверьте карточку снова.",
  reverification: "Завершите повторную проверку Google вручную.",
  unknown_dialog: "Закройте неизвестный диалог Google и повторите проверку.",
  identity_incomplete: "Не удалось надёжно прочитать название и адрес управляемой карточки.",
  manager_surface_changed: "Страница списка Businesses изменилась. Откройте список снова.",
  manager_selection_invalid: "Выберите карточку с названием и точным адресом.",
  manager_selection_ambiguous: "Найдено несколько одинаковых строк. Уточните Store code или адрес.",
  manager_selection_stale: "Строка больше не видна. Прокрутите её в таблице и повторите проверку.",
  source_tab_missing: "Откройте нужную карточку Google и снова нажмите значок GF."
};

const readableError = error => {
  const value = String(error?.message || error || "");
  if (/cannot access contents|cannot access a chrome/i.test(value)) {
    return "Браузер не дал расширению доступ к этой вкладке. Откройте business.google.com или Google Search и проверьте разрешение расширения для этого профиля.";
  }
  if (/receiving end does not exist|could not establish connection/i.test(value)) {
    return "Страница Google ещё загружается. Подождите секунду и нажмите «Проверить снова».";
  }
  if (/unsupported|исходная вкладка|откройте карточку/i.test(value)) {
    return "Откройте список Businesses либо управляемую карточку Google в этом же профиле браузера.";
  }
  return "Не удалось прочитать эту вкладку. Нажмите «Проверить снова»; если повторится, пришлите скрин этого сообщения.";
};

// Same rule as sourceUrl() in background.js: the tabs the editor can read.
const googleSource = value => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "business.google.com") return true;
    return /^(?:www\.)?google\.(?:com|ru)$/.test(url.hostname)
      && /^\/(?:search|local\/business)(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
};

const setState = (kind, title, detail, canOpen = kind === "ready") => {
  state.className = `status ${kind}`;
  state.querySelector("b").textContent = title;
  state.querySelector("p").textContent = detail;
  open.disabled = !canOpen;
};

const setSurface = (kind) => {
  const manager = kind === "manager";
  subtitle.textContent = manager ? "Список Businesses" : kind === "other" ? "Вкладка не из Google" : "Карточка Google";
  network.hidden = !manager;
  open.hidden = manager;
};

const showBound = tab => {
  bound.textContent = tab?.title || "нет";
  bound.title = tab?.title || "";
  bound.classList.toggle("muted", !tab);
};

// Q8-A: opening the popup only looks. It reads which tab is connected from
// session storage and never sends inspect_source/capture_source by itself.
async function connection() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.session.get("sourceTabId");
  const tab = stored?.sourceTabId ? await chrome.tabs.get(stored.sourceTabId).catch(() => undefined) : undefined;
  return { active, source: tab && googleSource(tab.url) ? tab : undefined };
}

function render(response) {
  if (response?.surface === "businesses") {
    setSurface("manager");
    const visible = Array.isArray(response.managerProfiles) ? response.managerProfiles.length : 0;
    const context = response.managerContext;
    const empty = context?.completeness === "confirmed_empty";
    const scope = context?.scope === "current_list" ? "Текущий список Google"
      : context?.group?.label ? `Группа Google: ${context.group.label}` : "Группа не определена";
    const blocked = response.blocker && response.blocker !== "manager_selection_required";
    setState(blocked ? "blocked" : "ready", "Список Businesses найден", blocked
      ? blockers[response.blocker] || "Состояние списка пока не подтверждено. Проверьте страницу Google."
      : `${scope}. ${empty ? "В этом списке карточек нет; другие группы и локальные данные не затронуты." : visible ? `${visible} видимых строк; это не весь аккаунт.` : "Откройте редактор сети: выберите группу, если она есть, затем считайте текущий список."}`, false);
    return;
  }
  setSurface("card");
  if (response?.blocker) {
    setState("blocked", "Нужна проверка", blockers[response.blocker] || "Текущий экран Google пока не поддерживается.", true);
    return;
  }
  const title = response?.name || "Карточка Google найдена";
  const detail = response?.address || "Название и адрес сверим ещё раз перед записью.";
  setState("ready", title, detail);
}

const reset = () => {
  connect.hidden = true;
  connect.disabled = false;
  open.className = "";
  open.textContent = "Открыть редактор";
  setSurface("unknown");
  setState("pending", "Проверяем вкладку…", "Ищем видимую карточку Google.");
};

async function inspect() {
  reset();
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    open.textContent = "Открыть редактор без карточки";
    setState("blocked", "Карточка не найдена", "Откройте это окно через значок установленного расширения.", true);
    return;
  }
  try {
    const { active, source } = await connection();
    showBound(source);
    if (!googleSource(active?.url)) {
      setSurface("other");
      if (source) {
        setState("pending", "Эта вкладка не из Google", "Редактор продолжит работать с подключённой вкладкой. Чтобы сменить её, откройте карточку или список Businesses и снова откройте это окно.", true);
        return;
      }
      open.textContent = "Открыть редактор без карточки";
      setState("blocked", "Карточка не найдена", "Откройте список Businesses или карточку компании в Google и снова откройте это окно. Редактор можно открыть и без неё.", true);
      return;
    }
    if (source?.id !== active.id) {
      subtitle.textContent = "Вкладка Google";
      connect.hidden = false;
      open.className = "secondary";
      if (!source) open.textContent = "Открыть редактор без карточки";
      setState("pending", "Эта вкладка не подключена", source
        ? "Редактор сейчас работает с другой вкладкой. Подключите эту, чтобы работать с ней. Подготовленную запись придётся подтвердить заново."
        : "Редактор работает с одной вкладкой Google. Подключите эту, чтобы читать её.", true);
      return;
    }
    const status = await chrome.runtime.sendMessage({ type: "source_status" });
    if (status?.error) throw new Error(status.error);
    render(status?.profile);
  } catch (error) {
    open.textContent = "Открыть редактор без карточки";
    setState("blocked", "Не удалось проверить вкладку", readableError(error), true);
  }
}

connect.addEventListener("click", async () => {
  connect.disabled = true;
  open.disabled = true;
  setState("pending", "Подключаем вкладку…", "Читаем видимую карточку Google.");
  try {
    const response = await chrome.runtime.sendMessage({ type: "inspect_source" });
    if (response?.error) throw new Error(response.error);
    connect.hidden = true;
    open.className = "";
    open.textContent = "Открыть редактор";
    showBound((await connection()).source);
    render(response);
  } catch (error) {
    connect.disabled = false;
    setState("blocked", "Вкладка не подключена", readableError(error), true);
  }
});

open.addEventListener("click", async () => {
  open.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "open_workspace" });
    if (response?.error) {
      setState("blocked", "Не удалось открыть", "Перезапустите расширение на странице chrome://extensions.", true);
      return;
    }
    window.close();
  } catch {
    setState("blocked", "Не удалось открыть", "Перезапустите расширение на странице chrome://extensions.", true);
  }
});

retry.addEventListener("click", inspect);
network.addEventListener("click", async () => {
  network.disabled = true;
  try {
    await chrome.storage.local.set({ "gbp.view": "cities" });
    const response = await chrome.runtime.sendMessage({ type: "open_workspace" });
    if (response?.error) throw new Error(response.error);
    window.close();
  } catch {
    network.disabled = false;
    setState("blocked", "Редактор не открыт", "Повторите из списка Businesses.");
  }
});
// R-74: the API row shows what background reports, not a fixed string.
globalThis.chrome?.runtime?.sendMessage?.({ type: "api_status" })?.then(status => {
  if (!status || status.error) return;
  api.textContent = status.available ? "подключён" : "не настроен";
  api.title = status.reason || "";
  api.classList.toggle("muted", !status.available);
})?.catch(() => {});
void inspect();
