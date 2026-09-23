import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function git(root, args, optional = false) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) { if (optional) return ""; throw new Error(error.stderr?.toString().trim() || error.message); }
}
export function readTeam(root = defaultRoot) {
  return JSON.parse(readFileSync(resolve(root, "team.config.json"), "utf8")).members;
}
export function resolveMember(name, members) {
  const normalized = name.trim().toLocaleLowerCase("ru");
  return Object.entries(members).find(([key, member]) => key === normalized || member.aliases.includes(normalized));
}
function memberConfig(root) {
  // Git gives linked worktrees separate administrative directories.
  return resolve(git(root, ["rev-parse", "--absolute-git-dir"]), "moneygraph.config");
}
export function selectedMember(root = defaultRoot) {
  return git(root, ["config", "--file", memberConfig(root), "--get", "member.name"], true);
}
export function start(name, root = defaultRoot) {
  const match = resolveMember(name, readTeam(root));
  if (!match) throw new Error("Неизвестное имя. Укажите Илья, Ерасыл или Родион; ветка не изменена.");
  const [key, member] = match;
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== realpathSync(root)) throw new Error("Запускайте настройку в отдельном клоне Money Graph.");
  const current = git(root, ["branch", "--show-current"]);
  if (!current) throw new Error("Detached HEAD: сначала согласуйте сохранение текущей работы; автоматическое переключение остановлено.");
  const hooks = git(root, ["config", "--get", "core.hooksPath"], true);
  if (hooks && hooks !== ".githooks") throw new Error(`Уже настроены git hooks (${hooks}). Их нельзя перезаписать автоматически; согласуйте объединение.`);
  if (!hooks) {
    const defaultHooks = resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]));
    if (existsSync(defaultHooks) && readdirSync(defaultHooks).some(name => !name.endsWith(".sample") && !name.startsWith("."))) {
      throw new Error("В стандартном каталоге Git уже есть пользовательские hooks. Их нельзя отключить автоматически; согласуйте объединение.");
    }
  }
  if (current !== member.branch) {
    if (git(root, ["status", "--porcelain", "--untracked-files=all"])) {
      throw new Error("Есть незакоммиченные или неотслеживаемые изменения. Ветка не изменена. Сначала согласуйте сохранение работы; скрипт не делает stash, reset или commit.");
    }
    if (git(root, ["show-ref", "--verify", `refs/heads/${member.branch}`], true)) {
      git(root, ["switch", member.branch]);
    } else if (git(root, ["show-ref", "--verify", `refs/remotes/origin/${member.branch}`], true)) {
      git(root, ["switch", "--track", "-c", member.branch, `origin/${member.branch}`]);
    } else {
      throw new Error(`Ветка ${member.branch} не найдена. Выполните git fetch origin и повторите; ветка не создаётся от случайного HEAD.`);
    }
  }
  git(root, ["config", "--file", memberConfig(root), "member.name", key]);
  git(root, ["config", "--local", "core.hooksPath", ".githooks"]);
  if (git(root, ["branch", "--show-current"]) !== member.branch) throw new Error("Не удалось подтвердить целевую ветку.");
  return `${member.name}: ${member.branch}. Зона: ${member.paths.join(", ")}. Промпт: ${member.prompt}`;
}
export function check(root = defaultRoot) {
  const key = selectedMember(root);
  const member = readTeam(root)[key];
  if (!member) throw new Error("Участник не выбран. Выполните npm run team:start и ответьте на вопрос об имени.");
  const branch = git(root, ["branch", "--show-current"]);
  if (branch !== member.branch) throw new Error(`${member.name} должен работать в ${member.branch}; сейчас ${branch || "detached HEAD"}. Запустите npm run team:start.`);
  return `${member.name}: ветка ${branch} подтверждена.`;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") { console.log(check()); return; }
  if (command !== "start") throw new Error("Используйте npm run team:start либо npm run team:check.");
  let name;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--name") throw new Error("Допустим только --name <имя>.");
    name = args[1];
  } else {
    if (!process.stdin.isTTY) throw new Error("Сначала спросите участника: «Как тебя зовут?» Затем передайте ответ через --name. Имя нельзя угадывать по git config.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { name = await rl.question("Как тебя зовут? "); } finally { rl.close(); }
  }
  console.log(start(name));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
