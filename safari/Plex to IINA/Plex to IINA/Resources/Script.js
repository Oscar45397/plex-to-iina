// The app's window: whether the Safari extension is on, the download queue, and the
// downloads library. ViewController.swift calls show, showDownloads and showLibrary.

function post(message) {
    webkit.messageHandlers.controller.postMessage(message);
}

// The Safari extension's state (true, false, or unknown).
function show(enabled, useSettingsInsteadOfPreferences) {
    const state = document.querySelector(".extension .state");
    const settings = useSettingsInsteadOfPreferences ? "Safari Settings" : "Safari Preferences";
    document.querySelector(".open-preferences").textContent = `${settings}…`;
    document.body.classList.toggle("extension-on", enabled === true);
    document.body.classList.toggle("extension-off", enabled === false);
    state.textContent = enabled === true ? "Safari extension on"
        : enabled === false ? "Safari extension off" : "Turn on the Safari extension in";
}

// Files waiting or downloading (Downloads.swift). Finished ones show in the library.
function showDownloads(state) {
    const active = state.items.filter((item) => item.status !== "done");
    const section = document.getElementById("downloading");
    section.hidden = active.length === 0;
    section.querySelector(".queue").replaceChildren(...active.map(queueRow));
    section.querySelector(".cancel-downloads").hidden = !state.busy;
}

function queueRow(item) {
    const row = element("li", item.status);
    const status = {
        queued: "Waiting",
        downloading: item.total ? `${Math.floor((100 * item.received) / item.total)}% of ${formatBytes(item.total)}` : formatBytes(item.received),
        cancelled: "Stopped",
        failed: item.error || "Failed",
    }[item.status];
    row.append(element("span", "name", item.label), element("span", "status", status));
    if (item.status === "downloading") {
        const bar = document.createElement("progress");
        bar.max = item.total || 1;
        bar.value = item.received;
        row.append(bar);
    }
    return row;
}

// Shows kept ahead (KeepAhead.swift): how many are ready, and when the server last answered.
function showKept(state) {
    const section = document.getElementById("kept");
    section.hidden = state.shows.length === 0;
    section.querySelector(".kept").replaceChildren(...state.shows.map(keptRow));
    const login = state.shows[0]?.loginItem;
    section.querySelector(".login").textContent = login === "on" ? "Checks in the background, also after login"
        : login === "approve" ? "Allow it in System Settings › Login Items" : "Checks while this app is open";
}

function keptRow(show) {
    const row = element("li");
    const text = element("div", "kept-text");
    text.append(element("span", "name", show.title),
        element("span", "status", `${show.ready} of ${show.lead} ready · ${lastReached(show.lastReached)}`));
    const stop = element("button", "link", "Stop");
    stop.title = `Stop keeping ${show.title} ahead`;
    stop.addEventListener("click", () => post({ action: "unkeep", id: show.id }));
    row.append(text, stop);
    return row;
}

function lastReached(time) {
    if (!time) return "waiting for the server";
    const date = new Date(time);
    const today = new Date().toDateString() === date.toDateString();
    const when = today ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleDateString([], { day: "numeric", month: "short" });
    return `server reached ${today ? "at " : "on "}${when}`;
}

// What's on disk (Library.swift): shows with their episodes, then films.
function showLibrary(library) {
    const shelf = document.querySelector("#library .shelf");
    const cards = [...library.shows.map(showCard), ...library.films.map(filmCard)];
    shelf.replaceChildren(...cards);
    document.querySelector("#library .empty").hidden = cards.length > 0;
    const total = [...library.shows, ...library.films].reduce((sum, item) => sum + item.size, 0);
    document.querySelector("#library .total").textContent = cards.length ? formatBytes(total) : "";
}

function showCard(show) {
    const card = element("article", "card");
    const body = element("div", "body");
    const count = show.episodes.length;
    body.append(element("h3", "", show.name), element("p", "meta", `${count} episode${count === 1 ? "" : "s"} · ${formatBytes(show.size)}`));
    const list = element("ul", "episodes");
    for (const episode of show.episodes) {
        const row = element("li", "playable");
        row.append(playButton(episode.id, `${episode.code} ${episode.title}`),
            element("span", "code", episode.code),
            element("span", "title", episode.title || "Episode"),
            element("span", "size", formatBytes(episode.size)),
            fileTools(episode.id));
        row.addEventListener("dblclick", () => post({ action: "play", id: episode.id }));
        list.append(row);
    }
    body.append(list);
    card.append(poster(show.poster, show.name), body);
    return card;
}

function filmCard(film) {
    const card = element("article", "card film playable");
    const body = element("div", "body");
    body.append(element("h3", "", film.title), element("p", "meta", formatBytes(film.size)));
    const actions = element("div", "film-actions");
    actions.append(playButton(film.id, film.title, "Play"), fileTools(film.id));
    body.append(actions);
    card.append(poster(film.poster, film.title), body);
    card.addEventListener("dblclick", () => post({ action: "play", id: film.id }));
    return card;
}

function poster(source, name) {
    if (source) {
        const image = document.createElement("img");
        image.className = "poster";
        image.src = source;
        image.alt = "";
        return image;
    }
    // No poster (downloaded by Chrome, or not fetched): the first letter.
    return element("div", "poster placeholder", (name || "?").trim().charAt(0).toUpperCase());
}

function playButton(id, name, label) {
    const button = element("button", label ? "play wide" : "play");
    button.title = `Play ${name} in IINA`;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
    if (label) button.append(label);
    button.addEventListener("click", () => post({ action: "play", id }));
    return button;
}

function fileTools(id) {
    const tools = element("span", "tools");
    const reveal = element("button", "icon small");
    reveal.title = "Show in Finder";
    reveal.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
    reveal.addEventListener("click", () => post({ action: "reveal", id }));
    const trash = element("button", "icon small");
    trash.title = "Move to Trash";
    trash.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
    trash.addEventListener("click", () => post({ action: "trash", id }));
    tools.append(reveal, trash);
    return tools;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatBytes(bytes) {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

document.querySelector(".open-preferences").addEventListener("click", () => post("open-preferences"));
document.querySelector(".show-downloads").addEventListener("click", () => post("show-downloads"));
document.querySelector(".cancel-downloads").addEventListener("click", () => post("cancel-downloads"));
