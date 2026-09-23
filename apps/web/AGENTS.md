# Frontend — Илья

Общие правила находятся в корневом `AGENTS.md` и имеют приоритет. Перед работой прочитай `docs/TEAM_PLAN.md`, `docs/CONTRACTS.md` и `docs/prompts/ilya-frontend.md`.

- Ответственный: Илья. Рабочая ветка: `ilya-branch-front`.
- Основная зона изменений: `apps/web/**`. Общие контракты и файлы других участников согласовываются с владельцами.
- Следуй проверке личности и ветки из корневого `AGENTS.md`; при делегированной задаче начального каркаса используй явно предоставленный контекст владельца задачи.
- Стек фиксирован: Next.js App Router, TypeScript, Cytoscape.js. NestJS — единственный HTTP API.
- Используй только согласованную палитру `docs/design/xi-palette.svg` по разделу палитры в `docs/prompts/ilya-frontend.md`; оформи цвета общими токенами для UI и графа. Дополнительные цвета требуют согласования, а роли/кластеры должны различаться не только цветом.
- Не добавляй Next.js API routes для бизнес-логики, аналитические вычисления, БД или авторизацию.
- Идентификаторы int64 поступают строками; не преобразовывай их в `Number`. Аналитика и экспорт остаются в Python.
- Инициализируй Cytoscape на клиенте. Не перезапускай раскладку графа при каждом React-рендере.
- Не используй внешние шрифты, CDN или скрытую подмену реальных результатов моками.
- Интерфейс загрузки, графа, поиска, карточек, топа и скачивания реализован и объединён с API/CLI. Проверки fixture не заменяют сквозной браузерный сценарий на настоящих Parquet; не выдавай доступность API или успешную сборку за полную приёмку.
- После изменений запускай доступные проверки типов и сборку. Сообщай фактические результаты и непроверенные пункты.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
