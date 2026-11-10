"use strict";

const maxBackupBytes = 4 * 1024 * 1024;
const key = "tenant-requests-planner";
const statuses = { new: "Новое", in_progress: "В работе", waiting: "Ожидает ответа", closed: "Закрыто" };
const priorities = { high: "Высокий", normal: "Обычный", low: "Низкий" };
const names = ["tenant", "description", "receivedDate", "dueDate", "assignee", "status", "priority"];
const $ = (id) => document.getElementById(id);
const form = $("card-form");
const editor = $("editor");
const confirmation = $("confirm");
const views = {
  week: ["План на неделю", "На эту неделю обращений нет."],
  overdue: ["Просроченные", "Просроченных обращений нет."],
  upcoming: ["Ближайшие сроки", "Обращений с ближайшими сроками нет."],
  open: ["Все открытые", "Открытых обращений пока нет."],
  archive: ["Архив", "В архиве пока нет обращений."]
};
const deadlineSort = { ascending: "Срок по возрастанию", descending: "Срок по убыванию", priority: "Сначала высокий приоритет" };
const sortOptions = {
  week: { created: "Сначала добавленные", priority: "Сначала высокий приоритет" },
  overdue: deadlineSort, upcoming: deadlineSort, open: deadlineSort,
  archive: { recent: "Сначала недавно закрытые", older: "Сначала давно закрытые" }
};
const sortBy = { week: "created", overdue: "ascending", upcoming: "ascending", open: "ascending", archive: "recent" };
const filters = { query: "", status: "", priority: "" };
const priorityRank = { high: 0, normal: 1, low: 2 };
const dayLength = 86_400_000;
let view = "week";
let archiveQuery = "";
let currentDay = dayNumber(today());
let selectedDay = currentDay;
let followsToday = true;
let midnightTimer;

let journal;
let draft;
let confirmedAction;

function today() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

// UTC day numbers keep calendar arithmetic independent of daylight-saving transitions.
function dayNumber(value) {
  return Date.parse(value) / dayLength;
}

function monday(day) {
  const weekday = new Date(day * dayLength).getUTCDay();
  return day - (weekday + 6) % 7;
}

function dateInputValue(day) {
  return new Date(day * dayLength).toISOString().slice(0, 10);
}

const dayLabel = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC"
});
const rangeLabel = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC"
});

function syncDay() {
  const nextDay = dayNumber(today());
  if (currentDay !== nextDay) {
    currentDay = nextDay;
    if (followsToday) selectedDay = currentDay;
    const focusedCard = document.activeElement?.dataset.cardId;
    render();
    if (focusedCard) (cardButton(focusedCard) || $("list-title")).focus();
  }
  clearTimeout(midnightTimer);
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  midnightTimer = setTimeout(syncDay, Math.max(1, midnight.getTime() - Date.now()));
}

function calendarDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value >= "1900-01-01" && new Date(value).toJSON()?.slice(0, 10) === value;
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toJSON() === value;
}

function fieldErrors(card) {
  const errors = {};
  for (const [name, min, max] of [["tenant", 1, 200], ["description", 1, 5000], ["assignee", 0, 200]]) {
    if (typeof card[name] !== "string" || card[name].trim().length < min) errors[name] = "Заполните поле.";
    else if (card[name].trim().length > max) errors[name] = `Допустимо до ${max} символов.`;
  }
  if (!calendarDate(card.receivedDate)) errors.receivedDate = "Укажите корректную дату поступления.";
  if (card.dueDate !== null) {
    if (!calendarDate(card.dueDate)) errors.dueDate = "Укажите корректный срок ответа.";
    else if (!errors.receivedDate && card.dueDate < card.receivedDate) errors.dueDate = "Срок не может быть раньше даты поступления.";
  }
  return errors;
}

function normalizeCard(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)
    || typeof card.id !== "string" || !card.id.trim()
    || typeof card.status !== "string" || !Object.hasOwn(statuses, card.status)
    || typeof card.priority !== "string" || !Object.hasOwn(priorities, card.priority)
    || !timestamp(card.createdAt) || (card.status === "closed" ? !timestamp(card.closedAt) : card.closedAt !== null)
    || Object.keys(fieldErrors(card)).length) throw new Error("Некорректная запись.");
  const { id, tenant, description, receivedDate, dueDate, assignee, status, priority, createdAt, closedAt } = card;
  return { id, tenant: tenant.trim(), description: description.trim(), receivedDate, dueDate,
    assignee: assignee.trim(), status, priority, createdAt, closedAt };
}

function snapshot(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Ожидался объект журнала.");
  if (data.schemaVersion !== 1) throw new Error("Неподдерживаемая версия журнала.");
  if (!Array.isArray(data.requests)) throw new Error("В журнале отсутствует список обращений.");
  const ids = new Set();
  const requests = data.requests.map((record, index) => {
    try {
      const card = normalizeCard(record);
      if (ids.has(card.id)) throw new Error("Повторяющийся идентификатор.");
      ids.add(card.id);
      return card;
    } catch (error) {
      throw new Error(`Запись №${index + 1}. ${error.message}`);
    }
  });
  return { schemaVersion: 1, requests };
}

function readJournal() {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return { error: "Не удалось прочитать данные браузера.", unreadable: true };
  }
  try {
    const data = raw === null ? { schemaVersion: 1, requests: [] } : snapshot(JSON.parse(raw));
    return { raw, data };
  } catch (error) {
    const reason = error instanceof SyntaxError ? "Некорректный JSON." : error.message;
    return { raw, error: `Сохранённый журнал повреждён. ${reason}` };
  }
}

function element(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function formatDate(value) {
  return value.split("-").reverse().join(".");
}

function renderCard(card) {
  const article = document.createElement("article");
  const points = Array.from(card.description);
  const preview = element("p", points.slice(0, 160).join("") + (points.length > 160 ? "…" : ""));
  preview.className = "preview";
  const due = card.dueDate ? dayNumber(card.dueDate) : Infinity;
  if (card.status !== "closed" && due <= currentDay) {
    const badge = element("p", due < currentDay ? "Просрочено" : "Срок сегодня");
    badge.className = due < currentDay ? "deadline overdue" : "deadline";
    article.append(badge);
  }
  const details = document.createElement("dl");
  const fields = [
    ["Дата поступления", formatDate(card.receivedDate)],
    ["Срок ответа", card.dueDate ? formatDate(card.dueDate) : "Срок не назначен"],
    ["Кому передано", card.assignee || "Не передано"],
    ["Этап", statuses[card.status]], ["Приоритет", priorities[card.priority]]
  ];
  if (card.closedAt) {
    fields.push(["Дата закрытия", new Date(card.closedAt).toLocaleDateString("ru-RU")]);
  }
  for (const [label, value] of fields) {
    const group = document.createElement("div");
    group.append(element("dt", label), element("dd", value));
    details.append(group);
  }
  const button = element("button", "Открыть обращение");
  button.type = "button";
  button.dataset.cardId = card.id;
  button.setAttribute("aria-label", `Открыть обращение. ${card.tenant}`);
  button.disabled = Boolean(journal.error);
  article.addEventListener("click", (event) => {
    if (!button.disabled && (event.target === button || !window.getSelection()?.toString())) {
      openEditor(card.id, button);
    }
  });
  article.prepend(element(view === "week" ? "h4" : "h3", card.tenant), preview);
  article.append(details, button);
  return article;
}

function activeQuery() {
  return (view === "archive" ? archiveQuery : filters.query).trim().toLocaleLowerCase("ru");
}

function hasFilters() {
  return Boolean(activeQuery() || (view !== "archive" && (filters.status || filters.priority)));
}

function matchesView(card) {
  if (view === "archive") return card.status === "closed";
  if (card.status === "closed") return false;
  if (view === "open") return true;
  if (!card.dueDate) return false;
  const due = dayNumber(card.dueDate);
  if (view === "overdue") return due < currentDay;
  if (view === "upcoming") return due >= currentDay && due <= currentDay + 6;
  const start = monday(selectedDay);
  return due >= start && due <= start + 6;
}

function matchesFilters(card, query) {
  return (view === "archive" || ((!filters.status || card.status === filters.status)
    && (!filters.priority || card.priority === filters.priority)))
    && [card.tenant, card.description, card.assignee]
      .some((text) => text.toLocaleLowerCase("ru").includes(query));
}

function compareText(a, b) {
  return a < b ? -1 : Number(a > b);
}

function compareDue(a, b, direction) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction * compareText(a, b);
}

function compareCards(a, b) {
  const mode = sortBy[view];
  let order = 0;
  if (view === "archive") order = compareText(a.closedAt, b.closedAt) * (mode === "recent" ? -1 : 1);
  else if (mode === "priority") order = priorityRank[a.priority] - priorityRank[b.priority];
  if (!order && view !== "week" && view !== "archive") {
    order = compareDue(a.dueDate, b.dueDate, mode === "descending" ? -1 : 1);
  }
  return order || compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id);
}

function renderList() {
  const query = activeQuery();
  const filtered = hasFilters();
  $("reset").hidden = !filtered;
  const cards = (journal.data?.requests ?? [])
    .filter((card) => matchesView(card) && matchesFilters(card, query)).sort(compareCards);
  const list = document.createDocumentFragment();
  if (journal.error) list.append(element("p", "Журнал недоступен."));
  else if (!cards.length) {
    list.append(element("p", filtered ? "По заданным условиям ничего не найдено" : views[view][1]));
  }
  if (!journal.error && view === "week") {
    const start = monday(selectedDay);
    for (let day = start; day < start + 7; day += 1) {
      const section = document.createElement("section");
      section.className = "week-day";
      section.append(element("h3", dayLabel.format(day * dayLength)));
      const entries = cards.filter((card) => dayNumber(card.dueDate) === day);
      section.append(...(entries.length ? entries.map(renderCard) : [element("p", "Нет обращений")]));
      list.append(section);
    }
  } else if (cards.length) list.append(...cards.map(renderCard));
  $("list").replaceChildren(list);
}

function render() {
  for (const button of document.querySelectorAll("[data-view]")) {
    if (button.dataset.view === view) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
  $("list-title").textContent = views[view][0];
  $("new").disabled = Boolean(journal.error);
  $("retry").hidden = !journal.unreadable;
  $("export").disabled = Boolean(journal.error);
  $("import").disabled = Boolean(journal.unreadable);
  $("export-raw").hidden = !journal.error || journal.unreadable;
  $("storage-error").textContent = journal.error || "";
  $("week-controls").hidden = view !== "week";
  if (view === "week") {
    const start = monday(selectedDay);
    $("week-date").value = dateInputValue(selectedDay);
    $("week-range").textContent = `${rangeLabel.format(start * dayLength)} — ${rangeLabel.format((start + 6) * dayLength)}`;
    $("previous-week").disabled = start - 1 < dayNumber("1900-01-01");
    $("next-week").disabled = start + 7 > dayNumber("9999-12-31");
  }
  const archived = view === "archive";
  $("status-filter-label").hidden = $("priority-filter-label").hidden = archived;
  $("search").value = archived ? archiveQuery : filters.query;
  $("status-filter").value = filters.status;
  $("priority-filter").value = filters.priority;
  $("sort").replaceChildren(...Object.entries(sortOptions[view]).map(([value, label]) => new Option(label, value)));
  $("sort").value = sortBy[view];
  renderList();
}

function cardButton(id) {
  return Array.from($("list").querySelectorAll("[data-card-id]"))
    .find((button) => button.dataset.cardId === id);
}

function savedMessage(card, message) {
  if (matchesView(card) && matchesFilters(card, activeQuery())) return message;
  const destination = card.status === "closed" ? "«Архив» после сброса поиска" : "«Все открытые» после сброса фильтров";
  return `${message} Где найти: ${destination}.`;
}

function refresh() {
  journal = readJournal();
  render();
  if (draft && (journal.error || journal.raw !== draft.raw)) {
    draft.stale = true;
    for (const name of ["save", "reopen", "remove"]) $(name).disabled = true;
    $("form-error").textContent = "Журнал изменился или недоступен. Скопируйте введённый текст перед закрытием формы.";
  }
}

function clearErrors() {
  for (const name of names) {
    $(name).removeAttribute("aria-invalid");
    const message = $(`${name}-error`);
    if (message) message.textContent = "";
  }
  $("form-error").textContent = "";
}

function openEditor(id, opener) {
  const current = readJournal();
  if (current.error || current.raw !== journal.raw) {
    journal = current;
    render();
    $("notice").textContent = "Журнал изменился. Повторите действие.";
    $("list-title").focus();
    return;
  }
  const card = current.data.requests.find((entry) => entry.id === id);
  const values = card ?? { tenant: "", description: "", receivedDate: today(),
    dueDate: null, assignee: "", status: "new", priority: "normal" };
  const archived = card?.status === "closed";
  draft = { card, opener, raw: current.raw, stale: false };
  clearErrors();
  for (const name of names) $(name).value = values[name] ?? "";
  draft.initial = formValues();
  $("editor-title").textContent = card ? "Обращение" : "Новое обращение";
  $("status").disabled = !card || archived;
  $("reopen").hidden = $("remove").hidden = !archived;
  for (const name of ["save", "reopen", "remove"]) $(name).disabled = false;
  editor.showModal();
}

function formValues() {
  return Object.fromEntries(names.map((name) => [name, $(name).value]));
}

function dirty() {
  const values = formValues();
  return names.some((name) => values[name] !== draft.initial[name]);
}

function ask(message, action, onAccept, detail = "") {
  confirmedAction = onAccept;
  $("confirm-title").textContent = message;
  $("confirm-action").textContent = action;
  $("confirm-detail").textContent = detail;
  $("confirm-detail").hidden = !detail;
  confirmation.showModal();
}

confirmation.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const action = confirmedAction;
  confirmedAction = null;
  confirmation.close();
  if (event.submitter === $("confirm-action")) action();
});
confirmation.addEventListener("cancel", () => { confirmedAction = null; });

function closeEditor() {
  const { opener, card } = draft;
  draft = null;
  editor.close();
  const replacement = card && cardButton(card.id);
  (opener.isConnected ? opener : replacement || $("list-title")).focus();
}

function requestClose() {
  if (dirty() || draft.stale) ask("Закрыть форму без сохранения?", "Закрыть форму", closeEditor);
  else closeEditor();
}

function serialize(data) {
  const raw = JSON.stringify(data);
  if (new TextEncoder().encode(raw).length > maxBackupBytes) {
    throw new Error("Журнал превышает допустимый размер 4 МиБ.");
  }
  return raw;
}

function writeJournal(data) {
  const raw = serialize(data);
  try {
    localStorage.setItem(key, raw);
  } catch {
    throw new Error("Не удалось сохранить журнал.");
  }
  journal = { raw, data };
}

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showBackupError(message) {
  $("notice").textContent = "";
  $("backup-error").textContent = message;
}

function exportJournal(rawCopy) {
  $("backup-error").textContent = "";
  refresh();
  if (journal.unreadable || Boolean(journal.error) !== rawCopy) return;
  const date = today();
  if (rawCopy) download(journal.raw, `tenant-requests-${date}-raw.txt`, "text/plain;charset=utf-8");
  else {
    try {
      download(serialize(journal.data), `tenant-requests-${date}.json`, "application/json;charset=utf-8");
    } catch (error) {
      showBackupError(error.message);
    }
  }
}

function replaceJournal(expected, data, summary) {
  const current = readJournal();
  if (current.unreadable || current.raw !== expected) {
    refresh();
    showBackupError("Журнал изменился или недоступен. Выберите файл заново.");
    return;
  }
  try {
    writeJournal(data);
  } catch (error) {
    showBackupError(error.message);
    return;
  }
  render();
  $("notice").textContent = `Журнал восстановлен. ${summary}`;
}

$("export").addEventListener("click", () => exportJournal(false));
$("export-raw").addEventListener("click", () => exportJournal(true));

const backupFile = $("backup-file");
let importRequest;
$("import").addEventListener("click", () => {
  if (editor.open || confirmation.open) return;
  $("backup-error").textContent = "";
  $("notice").textContent = "";
  const current = readJournal();
  if (current.unreadable) {
    refresh();
    return;
  }
  importRequest = { raw: current.raw };
  backupFile.value = "";
  backupFile.click();
});

backupFile.addEventListener("change", async () => {
  const request = importRequest;
  const file = backupFile.files[0];
  backupFile.value = "";
  if (!request || !file || editor.open || confirmation.open) return;
  if (file.size > maxBackupBytes) {
    showBackupError("Размер файла превышает 4 МиБ.");
    return;
  }
  try {
    const text = await file.text();
    if (request !== importRequest || editor.open || confirmation.open) return;
    const data = snapshot(JSON.parse(text));
    serialize(data);
    const closed = data.requests.filter((card) => card.status === "closed").length;
    const summary = `Открытых: ${data.requests.length - closed}. Закрытых: ${closed}.`;
    $("import").focus();
    ask("Восстановление заменит все текущие обращения", "Заменить журнал",
      () => replaceJournal(request.raw, data, summary), summary);
  } catch (error) {
    if (request !== importRequest) return;
    const reason = error instanceof SyntaxError ? "Некорректный JSON." : error.message;
    showBackupError(`Не удалось прочитать копию. ${reason}`);
  }
});

function commit(expected, transform, message) {
  if (draft.stale) return;
  const current = readJournal();
  if (current.error || current.raw !== expected) {
    refresh();
    return;
  }
  try {
    const data = snapshot({ schemaVersion: 1, requests: transform(current.data.requests) });
    writeJournal(data);
  } catch (error) {
    $("form-error").textContent = `${error.message} Введённые данные остались в форме.`;
    return;
  }
  render();
  closeEditor();
  $("notice").textContent = message;
}

for (const [name, values] of [["status", statuses], ["priority", priorities]]) {
  for (const [value, label] of Object.entries(values)) $(name).add(new Option(label, value));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (draft.stale) return;
  clearErrors();
  const values = formValues();
  values.dueDate = values.dueDate || null;
  const errors = fieldErrors(values);
  if ($("dueDate").validity.badInput) errors.dueDate = "Укажите корректный срок ответа.";
  if (Object.keys(errors).length) {
    for (const [name, message] of Object.entries(errors)) {
      $(name).setAttribute("aria-invalid", "true");
      $(`${name}-error`).textContent = message;
    }
    $("form-error").textContent = "Проверьте выделенные поля.";
    $(Object.keys(errors)[0]).focus();
    return;
  }
  const previous = draft.card;
  const now = new Date().toISOString();
  const status = !previous ? "new" : previous.status === "closed" ? "closed" : values.status;
  const card = { ...values, status, id: previous?.id ?? crypto.randomUUID(),
    createdAt: previous?.createdAt ?? now, closedAt: status === "closed" ? previous?.closedAt ?? now : null };
  const message = savedMessage(card, "Обращение сохранено.");
  commit(draft.raw, (cards) => previous ? cards.map((item) => item.id === card.id ? card : item) : [...cards, card], message);
});

function readArchiveAction() {
  if (draft.stale) return null;
  const current = readJournal();
  if (current.error || current.raw !== draft.raw) {
    refresh();
    return null;
  }
  return current;
}

$("reopen").addEventListener("click", () => {
  const current = readArchiveAction();
  if (!current) return;
  const { card } = draft;
  const { raw } = current;
  const reopened = { ...card, status: "in_progress", closedAt: null };
  const reopen = () => commit(raw, (cards) => cards.map((item) => item.id === card.id ? reopened : item),
    savedMessage(reopened, "Обращение открыто повторно."));
  if (dirty()) ask("Открыть повторно без сохранения правок?", "Открыть повторно", reopen);
  else reopen();
});

$("remove").addEventListener("click", () => {
  const current = readArchiveAction();
  if (!current) return;
  const { card } = draft;
  const { raw } = current;
  ask(`Удалить навсегда обращение арендатора «${card.tenant}»?`, "Удалить навсегда", () => {
    commit(raw, (cards) => cards.filter((item) => item.id !== card.id), "Обращение удалено.");
  });
});

$("new").addEventListener("click", () => openEditor(null, $("new")));
$("cancel").addEventListener("click", requestClose);
$("retry").addEventListener("click", refresh);
editor.addEventListener("cancel", (event) => {
  event.preventDefault();
  requestClose();
});
for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    view = button.dataset.view;
    $("notice").textContent = "";
    render();
  });
}
for (const [value, label] of Object.entries(statuses)) {
  if (value !== "closed") $("status-filter").add(new Option(label, value));
}
for (const [value, label] of Object.entries(priorities)) $("priority-filter").add(new Option(label, value));
$("search").addEventListener("input", (event) => {
  if (view === "archive") archiveQuery = event.target.value;
  else filters.query = event.target.value;
  renderList();
});
for (const name of ["status", "priority"]) {
  $(`${name}-filter`).addEventListener("change", (event) => {
    filters[name] = event.target.value;
    renderList();
  });
}
$("sort").addEventListener("change", (event) => {
  sortBy[view] = event.target.value;
  renderList();
});
$("reset").addEventListener("click", () => {
  if (view === "archive") archiveQuery = "";
  else Object.assign(filters, { query: "", status: "", priority: "" });
  render();
  $("search").focus();
});

function selectWeek(day, follow) {
  selectedDay = day;
  followsToday = follow;
  render();
}
$("previous-week").addEventListener("click", () => {
  selectWeek(Math.max(dayNumber("1900-01-01"), monday(selectedDay) - 7), false);
});
$("next-week").addEventListener("click", () => selectWeek(monday(selectedDay) + 7, false));
$("current-week").addEventListener("click", () => {
  syncDay();
  selectWeek(currentDay, true);
});
$("week-date").addEventListener("change", (event) => {
  const date = event.target.value;
  if (calendarDate(date)) selectWeek(dayNumber(date), false);
  else event.target.value = dateInputValue(selectedDay);
});
window.addEventListener("focus", syncDay);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncDay();
});
window.addEventListener("storage", (event) => {
  if (event.key === key || event.key === null) refresh();
});
refresh();
syncDay();
