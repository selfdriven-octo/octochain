import https from "node:https";

const REGISTRY_URLS = [
  "https://book.world.dev.cardano.org/environments/mainnet/topology.json",
  "https://explorer.mainnet.cardano.org/relays/topology.json"
];

/**
 * Fetch peer list from Intersect / explorer registries
 */
export async function discoverPeers() {
  const peers = [];

  for (const url of REGISTRY_URLS) {
    try {
      const data = await fetchJSON(url);
      const list = data?.Producers || data?.peers || [];
      for (const p of list) {
        if (p.addr && p.port) peers.push({ host: p.addr, port: p.port });
      }
    } catch (e) {
      console.error("Discovery failed for", url, e.message);
    }
  }

  // dedupe + shuffle
  const unique = [...new Map(peers.map(p => [p.host + ":" + p.port, p])).values()];
  return unique.sort(() => Math.random() - 0.5);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}