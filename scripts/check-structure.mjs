import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const json = path => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const expect = (condition, message) => { if (!condition) problems.push(message); };
const directories = path => readdirSync(resolve(root, path), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const path of ["apps/web/package.json", "apps/api/package.json", "packages/contracts/package.json", "analytics/pyproject.toml", "analytics/src/money_graph/__main__.py", "compose.yaml", "docker/Dockerfile", "AGENTS.md", ".agents/skills/money-graph-team/SKILL.md"]) {
  expect(existsSync(resolve(root, path)), `Нет обязательного файла: ${path}`);
}
expect(equal(directories("apps"), ["api", "web"]), "В apps допускаются только api и web.");
expect(equal(directories("packages"), ["contracts"]), "В packages допускается только contracts.");
expect(equal(json("package.json").workspaces, ["apps/web", "apps/api", "packages/contracts"]), "Изменён фиксированный список npm workspaces.");
const allowedRoots = new Set(["apps", "analytics", "packages", "docker", "scripts", "docs", "data", "runs", "artifacts", "starter", "node_modules", "coverage"]);
for (const name of directories(".")) {
  if (!name.startsWith(".")) expect(allowedRoots.has(name), `Новый корневой каталог ${name} не входит в структуру монорепозитория.`);
}
for (const file of ["yarn.lock", "pnpm-lock.yaml", "apps/web/package-lock.json", "apps/api/package-lock.json", "packages/contracts/package-lock.json"]) {
  expect(!existsSync(resolve(root, file)), `Используйте единый корневой package-lock.json вместо ${file}.`);
}
for (const path of ["frontend", "backend", "server", "client", "services", "src"]) {
  expect(!existsSync(resolve(root, path)), `Не создавайте альтернативный корневой каталог ${path}; используйте согласованные зоны.`);
}
const forbidden = ["@nestjs/microservices", "@nestjs/typeorm", "@nestjs/sequelize", "@prisma/client", "bull", "bullmq", "ioredis", "kafkajs"];
for (const [path, expectedName] of [["apps/web", "@money-graph/web"], ["apps/api", "@money-graph/api"], ["packages/contracts", "@money-graph/contracts"]]) {
  const pkg = json(`${path}/package.json`);
  expect(pkg.name === expectedName, `${path}: изменено имя workspace.`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  expect(!deps["@money-graph/web"] && !deps["@money-graph/api"], `${path}: приложения не могут зависеть друг от друга.`);
  for (const dep of forbidden) expect(!deps[dep], `${path}: ${dep} выходит за согласованную архитектуру.`);
}
expect(Boolean(json("apps/web/package.json").dependencies.next), "Frontend должен использовать Next.js.");
expect(Boolean(json("apps/api/package.json").dependencies["@nestjs/core"]), "Backend должен использовать NestJS.");
const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => {
  const child = resolve(path, entry.name);
  if (["node_modules", ".next", "dist", ".git"].includes(entry.name)) return [];
  return entry.isDirectory() ? walk(child) : [child];
});
for (const path of ["apps/web/pages/api", "apps/web/src/pages/api"]) {
  expect(!existsSync(resolve(root, path)), "Next.js Pages API запрещён: HTTP API находится в NestJS.");
}
for (const file of walk(resolve(root, "apps/web"))) {
  expect(!/[/\\]route\.[cm]?[jt]sx?$/.test(file), "Next.js Route Handlers запрещены: HTTP API находится в NestJS.");
  if (/\.[jt]sx?$/.test(file)) {
    const code = readFileSync(file, "utf8");
    expect(!/["']use server["']/.test(code), "Server Actions с серверной логикой не входят в роль Next.js этого проекта.");
  }
}
const pyproject = readFileSync(resolve(root, "analytics/pyproject.toml"), "utf8");
expect(!/\b(fastapi|flask|django|celery)\b/i.test(pyproject), "Python используется как CLI, не как второй HTTP API или сервер задач.");
const branches = Object.values(json("team.config.json").members).map(member => member.branch).sort();
expect(equal(branches, ["ilya-branch-front", "rodion-branch-analytics", "yerasyl-branch-back"]), "Изменена карта веток участников.");
if (problems.length) { console.error(problems.map(problem => `- ${problem}`).join("\n")); process.exitCode = 1; }
else console.log("Структура Next.js + NestJS + Python CLI и карта веток соответствуют контракту.");
