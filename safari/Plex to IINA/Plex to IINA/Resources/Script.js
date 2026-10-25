function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText = "Plex to IINA’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.";
        document.getElementsByClassName('state-off')[0].innerText = "Plex to IINA’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.";
        document.getElementsByClassName('state-unknown')[0].innerText = "You can turn on Plex to IINA’s extension in the Extensions section of Safari Settings.";
        document.getElementsByClassName('open-preferences')[0].innerText = "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);

// Files downloading for the extension's Download button (Downloads.swift).
function showDownloads(state) {
    const section = document.getElementById("downloads");
    section.hidden = state.items.length === 0;
    document.body.classList.toggle("has-downloads", state.items.length > 0);
    section.querySelector("ul").replaceChildren(...state.items.map(downloadRow));
    section.querySelector(".cancel-downloads").hidden = !state.busy;
}

function downloadRow(item) {
    const row = document.createElement("li");
    row.className = item.status;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = item.label;
    name.title = item.label;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = {
        queued: "Waiting",
        downloading: item.total ? `${Math.floor((100 * item.received) / item.total)}% of ${formatBytes(item.total)}` : formatBytes(item.received),
        done: "Done",
        cancelled: "Stopped",
        failed: item.error || "Failed",
    }[item.status];
    status.title = status.textContent;
    const bar = document.createElement("progress");
    bar.max = item.total || 1;
    bar.value = item.status === "done" ? bar.max : item.received;
    bar.hidden = item.status !== "downloading";
    row.append(name, status, bar);
    return row;
}

function formatBytes(bytes) {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

document.querySelector("button.show-downloads").addEventListener("click", () => webkit.messageHandlers.controller.postMessage("show-downloads"));
document.querySelector("button.cancel-downloads").addEventListener("click", () => webkit.messageHandlers.controller.postMessage("cancel-downloads"));
