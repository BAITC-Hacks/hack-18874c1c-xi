import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, start, check, resolveMember, readTeam } from "../team.mjs";
import { validatePush } from "../check-push.mjs";

const config = fileURLToPath(new URL("../../team.config.json", import.meta.url));
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "money-graph-team-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Money Graph Tests"]);
  git(root, ["config", "user.email", "tests@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  copyFileSync(config, join(root, "team.config.json"));
  git(root, ["add", "team.config.json"]);
  git(root, ["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
  for (const member of Object.values(readTeam(root))) git(root, ["branch", member.branch]);
  return root;
}
test("all supported names map to their exact branch", () => {
  for (const [key, member] of Object.entries(readTeam())) {
    assert.equal(resolveMember(` ${member.name.toUpperCase()} `, readTeam())[0], key);
  }
});
test("known member switches clean worktree and enables branch check", t => {
  const root = repository(t);
  assert.match(start("Илья", root), /ilya-branch-front/);
  assert.equal(git(root, ["branch", "--show-current"]), "ilya-branch-front");
  assert.match(check(root), /Илья/);
});
test("dirty worktree is not switched or stashed", t => {
  const root = repository(t);
  writeFileSync(join(root, "unfinished.txt"), "keep my work");
  assert.throws(() => start("Родион", root), /незакоммиченные/);
  assert.equal(git(root, ["branch", "--show-current"]), "main");
  assert.equal(readFileSync(join(root, "unfinished.txt"), "utf8"), "keep my work");
  assert.equal(git(root, ["stash", "list"]), "");
});
test("unknown member cannot choose arbitrary branch", t => {
  const root = repository(t);
  assert.throws(() => start("someone-else", root), /Неизвестное имя/);
  assert.equal(git(root, ["branch", "--show-current"]), "main");
});
test("switching away from member branch fails check", t => {
  const root = repository(t);
  start("Ерасыл", root);
  git(root, ["switch", "main"]);
  assert.throws(() => check(root), /yerasyl-branch-back/);
});
test("already correct branch keeps unfinished work", t => {
  const root = repository(t);
  start("rodion", root);
  writeFileSync(join(root, "unfinished.txt"), "keep");
  start("Родион", root);
  assert.equal(readFileSync(join(root, "unfinished.txt"), "utf8"), "keep");
});
test("existing custom hooks are preserved", t => {
  const root = repository(t);
  git(root, ["config", "core.hooksPath", "custom-hooks"]);
  assert.throws(() => start("Илья", root), /перезаписать/);
  assert.equal(git(root, ["config", "--get", "core.hooksPath"]), "custom-hooks");
});
test("missing branch is not created from random HEAD", t => {
  const root = repository(t);
  git(root, ["branch", "-d", "ilya-branch-front"]);
  assert.throws(() => start("Илья", root), /git fetch origin/);
  assert.equal(git(root, ["branch", "--show-current"]), "main");
});
test("existing remote branch becomes a tracking branch", t => {
  const root = repository(t);
  git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  git(root, ["branch", "-d", "ilya-branch-front"]);
  git(root, ["update-ref", "refs/remotes/origin/ilya-branch-front", "HEAD"]);
  start("Илья", root);
  assert.equal(git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/ilya-branch-front");
});
test("detached HEAD is left unchanged", t => {
  const root = repository(t);
  git(root, ["checkout", "--detach", "HEAD"]);
  assert.throws(() => start("Родион", root), /Detached HEAD/);
  assert.equal(git(root, ["branch", "--show-current"]), "");
});
test("default custom hooks are not silently disabled", t => {
  const root = repository(t);
  writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.throws(() => start("Илья", root), /пользовательские hooks/);
  assert.equal(git(root, ["config", "--get", "core.hooksPath"], true), "");
});
test("separate worktrees retain separate member identities", t => {
  const root = repository(t);
  const parent = mkdtempSync(join(tmpdir(), "money-graph-worktree-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const worktree = join(parent, "ilya");
  git(root, ["worktree", "add", worktree, "ilya-branch-front"]);
  start("Илья", worktree);
  start("Родион", root);
  assert.match(check(root), /Родион/);
  assert.match(check(worktree), /Илья/);
});
test("push validates actual refs, destination and deletions", () => {
  const own = "refs/heads/ilya-branch-front";
  const sha = "1".repeat(40), zero = "0".repeat(40);
  assert.doesNotThrow(() => validatePush("origin", `${own} ${sha} ${own} ${zero}\n`, "ilya-branch-front"));
  assert.throws(() => validatePush("other", `${own} ${sha} ${own} ${zero}`, "ilya-branch-front"), /origin/);
  assert.throws(() => validatePush("origin", `${own} ${sha} refs/heads/main ${sha}`, "ilya-branch-front"), /своей ветки/);
  assert.throws(() => validatePush("origin", `(delete) ${zero} ${own} ${sha}`, "ilya-branch-front"), /своей ветки/);
  assert.throws(() => validatePush("origin", `refs/heads/yerasyl-branch-back ${sha} ${own} ${sha}`, "ilya-branch-front"), /своей ветки/);
});
