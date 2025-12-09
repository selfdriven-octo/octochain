
// Create a zk_ok UTxO at the verifier script after validating a Noir proof (stubbed).

import { Lucid, Kupmios, Data, toHex } from "lucid-cardano";

const ZK_SCRIPT_ADDRESS = process.env.ZK_SCRIPT_ADDRESS_L1 || process.env.ZK_SCRIPT_ADDRESS_L2;
const OGMIOS = process.env.L1_OGMIOS_URL || "ws://localhost:1337";
const KUPO = process.env.L1_KUPO_URL || "http://localhost:1442";
const NETWORK = Number(process.env.L1_NETWORK || 0);
const PAYMENT_SK = process.env.L1_PAYMENT_SK_HEX;

const ZkDatum = Data.Object({
  event_id: Data.Bytes(),
  epoch: Data.Integer(),
  ok: Data.Boolean(),
});

async function main(){
  if(!ZK_SCRIPT_ADDRESS) throw new Error("ZK_SCRIPT_ADDRESS_* env required");
  if(!PAYMENT_SK) throw new Error("L1_PAYMENT_SK_HEX required");
  const kupmios = new Kupmios(OGMIOS, KUPO);
  const lucid = await Lucid.new(kupmios, NETWORK===1?"Mainnet":"Preprod");
  lucid.selectWalletFromPrivateKey(PAYMENT_SK);

  const eventIdHex = process.argv[2]; // 64 hex bytes
  const epoch = BigInt(process.argv[3] || "0");
  const proofPath = process.argv[4] || "proofs/p.proof";

  // TODO: actually verify Noir proof here (call verifier or run nargo verify).
  // For now, we trust the caller and just craft the datum.
  const datum = Data.to({ event_id: eventIdHex, epoch, ok: true }, ZkDatum);
  const tx = await lucid.newTx()
    .payToContract(ZK_SCRIPT_ADDRESS, { inline: datum }, { lovelace: 2_000_000n })
    .complete();
  const signed = await tx.sign().complete();
  const txHash = await signed.submit();
  console.log("zk_ok utxo minted tx:", txHash);
}

main().catch(e=>{ console.error(e); process.exit(1); });
