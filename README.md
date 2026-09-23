# Money Graph — команда Xi

Фиксированный монорепозиторий: **Next.js + NestJS + Python CLI**. Главный приоритет — полное выполнение обязательного ТЗ, корректность, объяснимость, производительность и воспроизводимость.

**Аналитический CLI реализован; API и интерфейс пока остаются каркасом.** Python читает три Parquet, проверяет данные, считает метрики, шесть ролей, кластеры и приоритеты, создаёт три CSV и `analysis.json`. Независимый запуск проверен на предоставленном наборе локально и в Docker. Next.js пока только проверяет доступность NestJS; endpoints расчёта всё ещё возвращают HTTP 501. Готовность CLI не означает готовность всего решения. [Инструкция аналитики](analytics/README.md) · [Правила и методология](docs/METHODOLOGY.md).

## Команда и ветки

| Участник | Зона | Ветка |
| :--- | :--- | :--- |
| Илья | `apps/web/` — Next.js, TypeScript, Cytoscape.js | `ilya-branch-front` |
| Ерасыл | `apps/api/` — единственный API NestJS | `yerasyl-branch-back` |
| Родион | `analytics/` — пакетная аналитика Python | `rodion-branch-analytics` |

У каждого участника — свой клон или worktree. При открытии новой задачи Codex читает [AGENTS.md](AGENTS.md) и [проектный skill](.agents/skills/money-graph-team/SKILL.md), спрашивает «Как тебя зовут?» и после ответа запускает безопасное переключение ветки. Если skill не появился в интерфейсе, открыть Codex в корне этого Git-репозитория и начать новую задачу; AGENTS.md также явно указывает путь к skill.

Ручной эквивалент из корня клона:

```sh
git fetch origin
npm run team:start
npm run team:check
```

`team:start` работает без `npm install`, но требует Node.js. Он переключает только на соответствующую существующую ветку и включает локальные hooks. Незакоммиченные изменения при переходе с другой ветки, detached HEAD и конфликт существующих hooks останавливают переключение; скрипт не делает stash, commit, reset или force. Имена поддерживаются на русском и латиницей.

`main` — интеграционная ветка. Изменения передаются из личных веток после проверки и согласования интеграции. Hooks запрещают commit на ветке, не соответствующей выбранному человеку, и push чужой ветки или main; `npm run check:structure` проверяет согласованную архитектуру. Hooks и skill — защита рабочего процесса, не система прав доступа GitHub; серверная защита веток отдельно не настраивалась.

## Зафиксированная структура

```text
apps/
  web/                  # только Next.js UI — Илья
  api/                  # единственный HTTP API NestJS — Ерасыл
analytics/
  src/money_graph/      # Python CLI и вычисления — Родион
  tests/
  pyproject.toml
  requirements.lock
packages/contracts/    # общие TypeScript-типы и analysis.schema.json
docker/Dockerfile      # цели web, api, analytics
compose.yaml
scripts/               # вход участника, проверки структуры и ветки
.githooks/             # локальные pre-commit/pre-push
.agents/skills/money-graph-team/
.github/workflows/verify.yml
docs/                  # план, контракты и промпты
data/                  # исходные Parquet, исключены из Git
runs/                  # результаты API, исключены из Git
artifacts/             # результаты прямого CLI, исключены из Git
```

Нельзя переносить компоненты, создавать параллельные frontend/backend/services или второй HTTP API. Допускаются необходимые модули внутри своей зоны. Изменение стека и верхнего уровня требует решения владельца проекта; общий контракт меняется согласованно с потребителями. Корневые зависимости, Docker, scripts, skill и contracts — общая зона, за интеграцию отвечает Ерасыл. Используем один npm lockfile, без дополнительных pnpm/yarn lockfiles.

Правила разработки: Ерасыл использует [TDD: Red → Green → Refactor](docs/prompts/erasyl-backend.md#обязательный-подход-test-driven-development-tdd); Илья — [утверждённую палитру XI](docs/design/xi-palette.svg) по [frontend-промпту](docs/prompts/ilya-frontend.md#21-обязательная-палитра-xi). Эти требования также закреплены в AGENTS.md и командном skill. Это инструкции для дальнейшей реализации, не утверждение о том, что текущий UI уже оформлен по палитре.

## Запуск в Docker одной командой

Нужны Git, работающий Docker Engine/Desktop и Docker Compose v2+ с поддержкой `--wait`. Node.js и Python для самих контейнеров устанавливаются образами; Node.js 24 LTS нужен на хосте для командных скриптов и git hooks. Первый build загружает базовые образы и зависимости из реестров. Работа собранного каркаса локальная, без внешних API, шрифтов и CDN.

Из корня репозитория:

```sh
docker compose up --build --wait
```

- Интерфейс: [localhost:3000](http://localhost:3000).
- Проверка API: [localhost:3001/api/health](http://localhost:3001/api/health).
- API содержит Node.js 24 и Python 3.12 с аналитическим пакетом; будущий NestJS-процесс сможет вызывать `PYTHON_BIN` без второго Python-сервиса.
- Контейнеры слушают только loopback хоста. Каталог `runs/` сохраняется между перезапусками.

Команды проверки и остановки:

```sh
docker compose ps
docker compose logs --tail=100 api web
docker compose exec api python -m money_graph --check-environment
docker compose --profile tools run --rm --build analytics --check-environment
docker compose down
```

Сервис `analytics` — отдельная CLI-цель по профилю `tools`, не постоянно работающий сервер. Для прямого пересчёта положить три файла в `data/` и выполнить:

```sh
docker compose --profile tools run --rm --build analytics --input-dir /data --output-dir /artifacts/run-001
```

Команда создаёт `nodes_roles.csv`, `clusters.csv`, `top_nodes.csv` и внутренний `analysis.json`. Для повторного запуска используй новый каталог, например `run-002`: существующие результаты не перезаписываются. Данные организаторов разложены локально в `data/` и исключены из Git; после нового клонирования их нужно получить отдельно. Описание и starter сохранены в `docs/references/organizers/`. CLI проверен на реальном наборе, но сквозная приёмка через API/UI остаётся задачей команды.

Порты и адреса имеют рабочие значения по умолчанию. При необходимости создать локальный `.env` по [.env.example](.env.example). При смене WEB_PORT согласовать WEB_ORIGIN, при смене API_PORT — NEXT_PUBLIC_API_URL. Последний встраивается в Next.js при сборке: после изменения повторить `docker compose up --build --wait`. В браузере использовать `localhost`, а не внутреннее Docker-имя `api`.

## Локальная разработка с перезапуском при изменении кода

Рекомендуются Node.js 24 LTS, npm 11 и Python 3.12. Версии Node/Python записаны в `.node-version` и `.python-version`. Базовые Docker-образы закреплены проверенными multi-platform digests для воспроизводимости на amd64 и arm64; npm-зависимости фиксирует package-lock.json, Python-зависимости — requirements.lock. Обновление зависимостей и образов выполняется явно, с повторной проверкой сборки.

```sh
npm ci
npm run build:contracts
python3 -m venv .venv
.venv/bin/python -m pip install -r analytics/requirements.lock
.venv/bin/python -m pip install --no-deps -e ./analytics
.venv/bin/python -m money_graph --check-environment
```

Затем в двух терминалах:

```sh
npm run dev:api
```

```sh
npm run dev:web
```

Для будущего локального вызова Python из API задать `PYTHON_BIN` абсолютным путём к `.venv/bin/python`. В Windows эквивалент — `.venv\Scripts\python.exe`; команды выше написаны для macOS/Linux, Docker-сценарий одинаков для всех платформ.

После изменения общего пакета повторить `npm run build:contracts`. Не устанавливать зависимости отдельно в apps; запускать npm из корня с `--workspace` и сохранять общий lockfile.

## Проверки

```sh
npm run team:check
npm run check:structure
npm test
npm run build
npm run typecheck
.venv/bin/python -m unittest discover -s analytics/tests -v
.venv/bin/python -m money_graph --check-environment
docker compose config --quiet
```

`npm test` проверяет безопасный выбор ветки на изолированных временных репозиториях и HTTP-поведение каркаса API. Python-тесты проверяют входы, правила ролей, кластеризацию, точность денег/ID, выходные контракты, CLI и сохранность результатов. CI выполняет сборку, проверки структуры, типов и синтетические тесты; без локального датасета он не заменяет приёмку на выданных данных.

## Документы для разработки и сдачи

- [План команды, требования, веса оценки и приёмка](docs/TEAM_PLAN.md).
- [Контракты CLI, API, CSV и интерфейса](docs/CONTRACTS.md).
- [Ерасыл: backend-промпт](docs/prompts/erasyl-backend.md).
- [Илья: frontend-промпт](docs/prompts/ilya-frontend.md).
- [Родион: аналитический промпт](docs/prompts/analyst.md).
- [Исходное ТЗ](https://docs.google.com/document/d/1JPLU-G6R25Ge2hVaY2J9cqvrx7FGExj87XKwJPaMz3o/edit?tab=t.2mrm4atu16r8).

Правила шести ролей, пороги, формулы, ограничения и масштабирование до ~1 млн узлов описаны в [методологии](docs/METHODOLOGY.md). К сдаче остаётся подключить CLI к API и интерфейсу, провести сквозную приёмку, включить разрешённые выгрузки в комплект сдачи, актуализировать схему и подготовить пятиминутное демо. LLM-судьи не подключены и для обязательного расчёта не нужны.
