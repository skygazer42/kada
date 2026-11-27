export const remoteManifest = {
  id: "/remote/", name: "Kada", short_name: "Kada", start_url: "/remote/", scope: "/remote/", display: "standalone",
};

export const remoteWorker = String.raw`
function notificationTarget(data) {
  const id = data?.conversationId;
  const pairing = data?.pairingId;
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) &&
    typeof pairing === "string" && /^[a-f0-9]{64}$/.test(pairing) ? { conversationId: id, pairingId: pairing } : null;
}

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let target;
  try { target = notificationTarget(event.data?.json()); }
  catch { return; }
  if (!target) return;
  event.waitUntil(self.registration.showNotification("Kada", {
    body: "A task has an update.",
    tag: "kada-task-" + target.pairingId + "-" + target.conversationId,
    data: target,
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = notificationTarget(event.notification.data);
  if (!target) return;
  event.waitUntil((async () => {
    const hash = "#conversation=" + target.conversationId + "&pairing=" + target.pairingId;
    for (const client of await self.clients.matchAll({ type: "window" })) {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin || !["/remote", "/remote/"].includes(url.pathname)) continue;
      url.hash = hash;
      let current;
      try {
        current = url.href === client.url ? client : await client.navigate(url.href);
      } catch {
        // A tab can close or change workers between enumeration and navigation.
        continue;
      }
      if (!current) continue;
      try { await current.focus(); } catch { /* The target already navigated. */ }
      return;
    }
    await self.clients.openWindow("/remote/" + hash);
  })());
});
`;
