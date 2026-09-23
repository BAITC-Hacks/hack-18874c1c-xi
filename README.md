# Money Graph — команда Xi

Фиксированный монорепозиторий: **Next.js + NestJS + Python CLI**. Главный приоритет — полное выполнение обязательного ТЗ, корректность, объяснимость, производительность и воспроизводимость.

**Backend реализует загрузку → запуск Python → проверку артефактов → выдачу результата.** Next.js пока проверяет доступность NestJS. Python-пакет устанавливается, но расчёт ролей и кластеров ещё не реализован: принятая загрузка сейчас завершается `failed`, а CLI сообщает `PIPELINE_NOT_IMPLEMENTED`. API не создаёт фиктивных успешных результатов. Успешный backend-сценарий проверен на синтетических артефактах в тестах; успешная интеграция аналитики и приёмка реального датасета остаются открытыми.

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
- API содержит Node.js 24 и Python 3.12 с аналитическим пакетом; NestJS вызывает `PYTHON_BIN` отдельным процессом без второго Python-сервиса.
- Контейнеры слушают только loopback хоста. Каталог `runs/` сохраняется между перезапусками.

Команды проверки и остановки:

```sh
docker compose ps
docker compose logs --tail=100 api web
docker compose exec api python -m money_graph --check-environment
docker compose --profile tools run --rm --build analytics --check-environment
docker compose down
```

Сервис `analytics` — отдельная CLI-цель по профилю `tools`, не постоянно работающий сервер. Для прямого пересчёта после реализации алгоритмов положить три файла в `data/` и выполнить:

```sh
docker compose --profile tools run --rm --build analytics --input-dir /data --output-dir /artifacts
```

На текущем каркасе эта последняя команда намеренно заканчивается ошибкой `INPUT_FILES_MISSING` или `PIPELINE_NOT_IMPLEMENTED`. После реализации она должна создать `nodes_roles.csv`, `clusters.csv`, `top_nodes.csv` и внутренний `analysis.json`. Полная приёмка и лимит менее 300 секунд проверяются на реальном датасете; данных в репозитории пока нет.

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

Перед `npm run dev:api` задать `PYTHON_BIN` абсолютным путём: `export PYTHON_BIN="$PWD/.venv/bin/python"`. Локальный API читает переменные окружения процесса; корневой `.env` автоматически использует только Docker Compose.

В Windows PowerShell из корня (Python 3.12 рекомендуется; 3.13 также поддерживается пакетом):

```powershell
py -3.13 -m venv .venv
.venv/Scripts/python.exe -m pip install -r analytics/requirements.lock
.venv/Scripts/python.exe -m pip install --no-deps -e ./analytics
.venv/Scripts/python.exe -m money_graph --check-environment
$env:PYTHON_BIN = (Resolve-Path .venv/Scripts/python.exe).Path
npm run dev:api
```

Если установлен Python 3.12, заменить `py -3.13` на `py -3.12`. `PYTHON_BIN` — путь к исполняемому файлу, без аргументов и shell-команд. В Docker он уже задан как `/opt/venv/bin/python`.

После изменения общего пакета повторить `npm run build:contracts`. Не устанавливать зависимости отдельно в apps; запускать npm из корня с `--workspace` и сохранять общий lockfile.

При ошибке Next.js `EXDEV` при записи `nextjs-nodejs/Config/config.json` на Windows отключить телеметрию в текущем терминале: `$env:NEXT_TELEMETRY_DISABLED = '1'`, затем повторить `npm run build`. В Docker эта настройка уже задана.

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

`npm test` проверяет выбор ветки, HTTP-контракт, загрузки, изоляцию запусков, управление процессом, целостность JSON/CSV, dev-запуск и остановку API. Синтетические артефакты находятся только в `apps/api/test/fixtures/` и не используются продуктом. Python-тесты проверяют ошибки, параметры CLI и отсутствие фиктивных результатов. CI не заменяет приёмку аналитики на выданных данных.

Дополнительная проверка настоящего установленного CLI через HTTP (с заданным `PYTHON_BIN`):

```sh
npm run test:python --workspace @money-graph/api
```

Она проверяет окружение Python и два неуспешных запуска с намеренно некорректными файлами: `failed`, недоступность результатов и освобождение слота. Пока CLI — каркас, причина его отказа — отсутствие pipeline, а не проверка схем Parquet. Это не доказательство успешного анализа или корректной валидации содержимого Parquet.

## Backend: загрузка и результаты

Контракт v1 сохранён; дополнительные endpoints не добавлены. При работающем API отправить три настоящих файла:

```sh
curl -i -F "nodes=@data/nodes.parquet" -F "edges=@data/edges.parquet" -F "transactions=@data/transactions.parquet" http://localhost:3001/api/runs
```

В PowerShell использовать `curl.exe`. Ответ `202` содержит `{run_id, status:"running"}`. Подставить полученный идентификатор вместо `RUN_ID`:

```sh
curl http://localhost:3001/api/runs/RUN_ID
curl http://localhost:3001/api/runs/RUN_ID/result
curl -OJ http://localhost:3001/api/runs/RUN_ID/exports/nodes_roles.csv
curl -OJ http://localhost:3001/api/runs/RUN_ID/exports/clusters.csv
curl -OJ http://localhost:3001/api/runs/RUN_ID/exports/top_nodes.csv
```

- Слот резервируется до начала записи загрузки. Второй POST при занятом слоте получает `409`; очереди нет. Неполные, пустые, повторные, лишние поля, повреждённый multipart и превышение лимитов получают `400`.
- Имена назначает сервер: `runs/<uuid>/input/{nodes,edges,transactions}.parquet`; выходы — в отдельном `output/`. Оригинальное имя, расширение и MIME не определяют корректность Parquet: содержимое должен проверять Python.
- Python запускается с фиксированным `-m money_graph`, массивом аргументов, `shell: false`. API ждёт закрытия процесса и потоков, затем проверяет все четыре файла. Код выхода 0 сам по себе недостаточен для `completed`.
- Проверяются общая JSON Schema, int64-диапазон, строковые деньги, UTF-8, точные заголовки и содержимое CSV, уникальность, ссылки, размеры/seed-состав кластеров и порядок топа. Формулы ролей и оборотов в NestJS не пересчитываются. Покрытие исходных Parquet отдельно проверяет приёмка ниже.
- `result` и CSV доступны только после `completed`; до этого — `409`, включая `failed`. Неизвестный запуск и недопустимое имя выгрузки — `404`. Статус содержит `error:null` либо `{code,message}`; подробности процесса и валидации остаются в локальном логе.
- Основные коды: `UPLOAD_INVALID`, `RUN_ACTIVE`, `RUN_NOT_FOUND`, `RUN_NOT_COMPLETED`, `EXPORT_NOT_FOUND`, `PYTHON_START_FAILED`, `PYTHON_FAILED`, `PYTHON_TIMEOUT`, `PYTHON_CANCELLED`, `ARTIFACTS_INVALID`. При ошибке слот освобождается. Сбой нового запуска не подменяется предыдущим результатом.
- JSON и исходные байты проверенных CSV сохраняются в памяти каждого завершённого запуска: скачивание не пересчитывает и не переписывает суммы. Изменение выходного файла на диске после проверки не меняет опубликованный снимок.

Настройки API:

| Переменная | По умолчанию | Значение |
| :--- | :--- | :--- |
| `PYTHON_BIN` | `python` на Windows, `python3` на остальных ОС | Установленный Python; рекомендуется абсолютный путь к venv |
| `RUNS_DIR` | `runs/` в корне репозитория | Серверный каталог запусков |
| `UPLOAD_MAX_BYTES` | `134217728` | Максимум 128 MiB для каждого из трёх файлов; запись потоковая |
| `UPLOAD_TIMEOUT_MS` | `300000` | Максимальное время загрузки; обрыв/таймаут удаляет частичные входы |
| `PYTHON_TIMEOUT_MS` | `330000` | Технический таймаут процесса; TERM, через 2 секунды KILL, ожидание закрытия |

Технический таймаут не отменяет приёмочное требование **менее 300 секунд**. `elapsed_ms` статуса начинается после загрузки и включает запуск Python и проверку артефактов; после завершения не растёт. `metadata.elapsed_ms` приходит из Python и имеет отдельную границу измерения по контракту.

Один экземпляр API держит состояния в памяти. При штатной остановке активный процесс завершается, незаконченная загрузка очищается, соединения закрываются. После перезапуска API старые run_id получают `404`; каталоги на диске сохраняются для диагностики, автоматического восстановления нет. Удалять старые каталоги следует после остановки API. Для длительной работы потребуется политика хранения; текущий полный JSON и снимки в памяти не предназначены для ~1 млн узлов. Такое масштабирование потребует согласованного изменения формата выдачи, ограничений памяти и интерфейса; сейчас дополнительные endpoints не вводятся.

## Приёмка реального датасета

После готовности аналитики и получения данных задать `REAL_DATA_DIR` абсолютным путём к каталогу трёх исходных Parquet и `PYTHON_BIN`, затем выполнить:

```sh
npm run build:contracts
npm run test:dataset --workspace @money-graph/api
```

PowerShell: `$env:REAL_DATA_DIR = (Resolve-Path data).Path`; macOS/Linux: `export REAL_DATA_DIR="$PWD/data"`.

Команда запускает временный API с настоящим CLI, сравнивает полный набор строковых gid с реально прочитанным через PyArrow `nodes.parquet`, проверяет выдачу всех CSV и их исходные байты. Замеряется процесс снаружи от `spawn` до `close`, а также процесс вместе с backend-валидацией; оба должны быть `<300000 ms`. Установка, HTTP-загрузка и чтение gid для приёмки в этот интервал не входят. Отчёт содержит размеры файлов, metadata, CPU, ОС, версии Node/Python и длительность. Отсутствующие данные, неготовый CLI или ошибки приводят к падению теста, без подстановки fixture. Временные каталоги этой проверки удаляются.

На 23.09.2026 реальных Parquet нет, поэтому эта приёмка и лимит времени **не подтверждены**. Успешное отображение результата в UI также требует реализации Ильи и совместной проверки.

Фактические результаты TDD, сборки и интеграционных проверок backend: [BACKEND_VERIFICATION.md](docs/BACKEND_VERIFICATION.md).

## Документы для разработки и сдачи

- [План команды, требования, веса оценки и приёмка](docs/TEAM_PLAN.md).
- [Контракты CLI, API, CSV и интерфейса](docs/CONTRACTS.md).
- [Ерасыл: backend-промпт](docs/prompts/erasyl-backend.md).
- [Илья: frontend-промпт](docs/prompts/ilya-frontend.md).
- [Родион: аналитический промпт](docs/prompts/analyst.md).
- [Исходное ТЗ](https://docs.google.com/document/d/1JPLU-G6R25Ge2hVaY2J9cqvrx7FGExj87XKwJPaMz3o/edit?tab=t.2mrm4atu16r8).

К сдаче добавить фактические правила шести ролей, пороги, методологию оценок, ограничения и раздел масштабирования до ~1 млн узлов; измерить реальный пересчёт, приложить обязательные выгрузки, актуализировать схему и подготовить пятиминутное демо. Это оставшиеся задачи команды, не выполненные свойства стартового каркаса.
