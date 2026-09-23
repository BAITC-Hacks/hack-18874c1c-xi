import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, readTeam, selectedMember } from "./team.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function validatePush(remote, refs, branch) {
  if (remote !== "origin") throw new Error("Командная проверка разрешает push только в origin этого репозитория.");
  const expected = `refs/heads/${branch}`;
  for (const line of refs.split("\n").filter(Boolean)) {
    const [localRef, localSha, remoteRef] = line.split(/\s+/);
    if (remoteRef !== expected || localRef !== expected || /^0+$/.test(localSha)) {
      throw new Error(`Разрешена отправка только своей ветки ${branch} в одноимённую ветку origin. Удаление, чужие ветки и main запрещены этой проверкой.`);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    check(root);
    const member = readTeam(root)[selectedMember(root)];
    validatePush(process.argv[2], readFileSync(0, "utf8"), member.branch);
    console.log(`Push: только ${member.branch}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
