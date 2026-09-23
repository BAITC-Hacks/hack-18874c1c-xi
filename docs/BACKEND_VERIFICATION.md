# Backend: результаты проверок 23.09.2026

Первичная проверка Ерасыла ниже сохранена как история состояния его ветки. После объединения с аналитикой её открытые пункты частично закрыты; актуальные результаты — в разделе «Интеграция с аналитикой» в конце файла.

Участник: Ерасыл. Ветка: `yerasyl-branch-back`. На момент функциональной проверки коммиты, push и merge не выполнялись. API реализован по существующему контракту v1; общие типы, JSON Schema, аналитика и frontend не изменялись. Изменение `CONTRACTS.md` актуализирует только описание готовности.

## Реализовано

Загрузка ровно трёх непустых файлов в отдельный каталог; один слот на загрузку и расчёт; фиксированный Python CLI через `spawn` без shell; `running/completed/failed`; проверка всех четырёх артефактов перед публикацией; выдача JSON и трёх исходных CSV. Проверки сохраняют строки int64 и денег, не вычисляют аналитические правила.

Обработаны неверные и прерванные загрузки, превышение лимитов, конкурентные POST, неизвестный запуск, преждевременное чтение, недопустимое имя экспорта, ошибки запуска и завершения Python, таймаут, неполные/повреждённые/несогласованные результаты. После ошибки слот освобождается; результаты запусков изолированы. Остановка API завершает процесс и незавершённую загрузку.

## TDD: фактические Red и Green

| Этап | Red до реализации/исправления | Green |
| :--- | :--- | :--- |
| HTTP-загрузка, состояния, слоты, доступ к результатам | 9 падений из 12 проверок: заглушка возвращала 501 вместо контрактных ответов | 12/12; затем расширено проверками завершения, CSV, ошибок и обрывов |
| Артефакты | 63 ожидаемых падения из 65: baseline reader принимал повреждённые данные | 65/65 |
| Python-процесс | 11/11 падали на явной заглушке | 14/14, включая настоящие управляемые дочерние процессы |
| Dev-runtime `tsx` | `GET /api/runs/unknown` возвращал 500 вместо 404 | Явный `@Inject(RunsService)`, 1/1 |
| Повторный POST с неверным типом тела при активном расчёте | 400 вместо 409 | Слот проверяется первым, регрессионный тест проходит |
| Остановка с незавершённым multipart | Приложение не закрывалось, пока клиент не закрывал сокет | Ожидание очистки и закрытие соединений, 1/1 |

Синтетические данные и артефакты находятся только в тестах. Успешное завершение тестового управляемого процесса не представляется как результат настоящей аналитики.

## Команды и результаты

Окружение: Windows x64, Node.js `24.14.0`, npm `11.1.0`, Python `3.13.12`. В `.venv` установлены зависимости из `analytics/requirements.lock`, включая pandas `3.0.6`, PyArrow `25.0.1`, NetworkX `3.7`; пакет установлен через `pip install --no-deps -e ./analytics`.

| Команда из корня | Фактический результат |
| :--- | :--- |
| `node scripts/team.mjs start --name "Ерасыл"` | Нужная ветка и hooks настроены |
| `npm run team:check` | Успешно |
| `npm run check:structure` | Успешно |
| `npm ci --no-audit --no-fund` | Повторная установка из обновлённого lock-файла успешна, 149 пакетов |
| `npm test` | 13/13 командных тестов и 102/102 теста API, без пропусков |
| `npm run build` | Contracts и API собраны; первоначальная сборка Next.js остановилась на Windows EXDEV в файле телеметрии |
| `$env:NEXT_TELEMETRY_DISABLED='1'; npm run build` | Полная сборка contracts, API и Next.js успешна |
| `npm run typecheck` | Все workspace проходят |
| `.venv/Scripts/python.exe -m unittest discover -s analytics/tests -v` | 9/9 |
| `.venv/Scripts/python.exe -m money_graph --check-environment` | `environment_ready`, `pipeline_implemented:false` |
| `$env:PYTHON_BIN=(Resolve-Path .venv/Scripts/python.exe).Path; npm run test:python --workspace @money-graph/api` | 1/1: два настоящих CLI-запуска через HTTP дали `failed/PYTHON_FAILED`, доступ к результатам закрыт, следующий запуск принят |
| `docker compose config --quiet` | Успешно |
| `docker compose build api` | Успешно; образ `money-graph-api` собран с Node 24 и Python 3.12 |
| `docker compose up --wait` | Успешно; `api` и `web` healthy |
| `GET http://localhost:3001/api/health` | HTTP 200, `{"status":"ok","service":"api","analytics":"not_implemented"}` |
| `GET http://localhost:3000` | HTTP 200 |
| `git diff --check` | Без ошибок whitespace |

Настоящие CLI-запуски в этой проверке длились 218 и 242 ms и завершились ошибкой отсутствующего pipeline. **Эти длительности не являются измерением аналитического пересчёта.** Проверка содержимого Parquet самим CLI ещё не реализована.

## Изменённые файлы

- Реализация: `apps/api/src/{app.module,bootstrap,runs.controller,runs.service,run-config,run-upload,python-runner,artifacts}.ts`.
- Тесты: `apps/api/test/{http,runs,artifacts,python-runner,dev-runtime,shutdown}.test.cjs`; синтетический `apps/api/test/fixtures/artifacts.cjs`.
- Настоящий CLI и будущая приёмка данных: `apps/api/test/python-cli.integration.cjs`, `apps/api/test/dataset.integration.cjs`.
- Зависимости и команды: `apps/api/package.json`, `package-lock.json`.
- Запуск и документация: `.env.example`, `compose.yaml`, `README.md`, `docs/CONTRACTS.md`, `apps/api/AGENTS.md`, этот отчёт.

Появившийся во время работы чужой `requirements.txt` не менялся и не использовался вместо закреплённых зависимостей.

## Открытая приёмка и зависимости

1. CLI Родиона пока возвращает `PIPELINE_NOT_IMPLEMENTED`. Успешный настоящий расчёт, проверка Parquet, метрики и экспорты аналитики не подтверждены.
2. В `data/` нет исходных Parquet, `starter/` отсутствует. Проверка всех исходных gid, включая изоляты, официальных CSV и полного времени <300 секунд остаётся открытой. Команда `npm run test:dataset --workspace @money-graph/api` подготовлена, но на реальном датасете не запускалась; обязательны `REAL_DATA_DIR` и `PYTHON_BIN`.
3. Интерфейс пока является каркасом. Совместная проверка загрузки, произвольного gid, изолята, depth=4 и скачивания результатов требует frontend Ильи и готового CLI.
4. Docker Engine доступен через контекст `desktop-linux` (Docker Desktop 4.88.1, Engine 29.7.2); `docker compose build api` и `docker compose up --wait` прошли, оба контейнера healthy. Контейнеры оставлены запущенными для ручной проверки; остановка: `docker compose down`.
5. Ссылка на исходное Google Docs ТЗ недоступна инструменту чтения; использованы сохранённые требования `TEAM_PLAN.md`, `CONTRACTS.md` и backend-промпта. Ссылаемый `RTK.md` в репозитории отсутствует.

Backend не объявляется доказательством готовности всего продукта. Перед сдачей необходимо закрыть перечисленную приёмку на настоящих данных и дополнить README фактической методологией аналитика.

## Интеграция с аналитикой — 23.09.2026, Родион

В `rodion-branch-analytics` объединены аналитика `7dab006` и backend `6fa733a` (merge `1a40fc4`). На момент fetch ветка `origin/ilya-branch-front` всё ещё указывала на общий каркас `9b8896b`, дополнительных frontend-коммитов для включения не было.

При интеграции выявлена несовместимость публикации каталога на Windows: API заранее создавал `output/`, тогда как Python переименовывает в этот путь готовый каталог. По TDD добавлен тест отсутствия пути при старте Python: RED (`true !== false`), затем убран только предварительный `mkdir(outputDir)`; GREEN — регрессия и весь backend. Native Windows в этой задаче не запускался; сценарий проверен на macOS и Linux/Docker.

Фактические проверки объединённого кода:

- `npm test`: 13 командных тестов и 103 backend-теста прошли без пропусков; `npm run typecheck` прошёл.
- Python: 71 тест на реальном наборе на macOS / Python 3.14.5 и 71 тест в Linux/Docker / Python 3.12.14 (данные смонтированы read-only, `MONEY_GRAPH_DATA_DIR=/data`) — PASS.
- `PYTHON_BIN="$PWD/.venv/bin/python" npm run test:python --workspace @money-graph/api`: PASS; два некорректных входа дали `failed/PYTHON_FAILED`, следующий запуск разрешён.
- `PYTHON_BIN="$PWD/.venv/bin/python" REAL_DATA_DIR="$PWD/data" npm run test:dataset --workspace @money-graph/api`: PASS. Настоящие 2 248 узлов, 3 119 рёбер, 4 840 транзакций, 81 seed; точное множество исходных gid и байты CSV проверены. Python-процесс — 464,194 ms; процесс + backend-валидация — 507 ms. Машина: Apple M4, macOS arm64, Node v26.0.0, Python 3.14.5. Локальная версия Node выше целевой; целевой runtime дополнительно проверен ниже.
- `docker compose up --build --wait`: образы API и Next.js собраны; оба сервиса healthy. Runtime API: Node v24.21.0, Python 3.12.14, Linux aarch64.
- Те же 103 backend-теста прошли в Docker. Для dev-runtime теста подключён `tsconfig.base.json` read-only: production-образ не содержит корневого TS-конфига, поэтому его запуск без этого файла сначала упал; compiled production API от этого не зависит.
- Настоящий HTTP-сценарий Docker: multipart → `completed` → JSON → три CSV; 2 248 узлов, 107 кластеров. Байты скачанных CSV совпали с опубликованными файлами. `elapsed_ms` backend — 644 ms; весь HTTP-сценарий, включая загрузку, polling и чтение результата/экспортов/главной страницы — 1 103 ms. Это один фактический прогон, не универсальная гарантия времени.
- `team:check`, `check:structure`, `git diff --check` — PASS. Датасет и результаты не добавлены в Git; данные не отправлялись внешним AI.

Открыты UI-приёмка Ильи, согласованное обновление старого поля `health.analytics`, финальный комплект сдачи и демо. Успешный backend/CLI не означает готовность пользовательского интерфейса. Контейнеры оставлены запущенными локально; остановка — `docker compose down`.

### Дополнительно включён frontend

Перед публикацией обнаружен новый `origin/ilya-branch-front` — `fa9b0b5`; он включён merge-коммитом `a7b56bb`. Прошли 51 frontend unit-тест, общая проверка типов и структуры; повторный `docker compose up --build --wait` собрал обе реализации, оба сервиса healthy. Настоящий `analysis.json` принят frontend-валидатором без потерь ID/денег. Контракты не менялись. Браузерные тесты из frontend-ветки используют синтетические ответы и не заменяют ещё не проведённую сквозную UI-проверку на реальных Parquet. Новый UI не зависит от старого поля health.

## Приёмка предоставленных Parquet — 23.09.2026, Ерасыл

Проверен код `53f2437` в `yerasyl-branch-back`, включая аналитику Родиона и исправления публикации результатов на Windows. Владелец временно предоставил три настоящих входа: `nodes.parquet` (11 905 B), `edges.parquet` (34 187 B), `transactions.parquet` (40 745 B). Исходные строки, gid, JSON и CSV в этот отчёт не включены.

Проверены точное множество всех 2 248 исходных узлов, 3 119 рёбер, 4 840 транзакций и 81 seed; сохранение изолятов и ограничений depth=4; точные денежные агрегаты; воспроизводимость после перестановки строк настоящих Parquet. HTTP-приёмка выполняет multipart-загрузку в отдельный временный API, настоящий Python CLI, проверку артефактов, получение `completed`, JSON и всех трёх CSV. Скачанные CSV побайтово совпадают с файлами расчёта.

| Проверка | Результат |
| :--- | :--- |
| Python unittest, Windows x64 / Python 3.13.12 | 84 теста, ошибок нет; 2 пропуска только для создания symlink без права Windows. Все 4 проверки реального набора прошли |
| Python unittest, Docker Linux x64 / Python 3.12.14 | 84 теста, ошибок нет; 3 пропуска только для Windows fallback. Все 4 проверки реального набора и обе symlink-проверки прошли |
| `npm run test:dataset --workspace @money-graph/api`, Windows / Node v24.14.0 | 1/1; Python-процесс 1 902,9454 ms; процесс + backend-валидация **2 007 ms** |
| `node --test apps/api/test/dataset.integration.cjs`, Docker / Node v24.21.0 | 1/1; Python-процесс 1 822,753 ms; процесс + backend-валидация **1 927 ms** |

Машина: Intel Core i5-11400H, Windows x64 с Docker Linux x64. Оба внешних замера полного процесса (от `spawn` до `close`, включая чтение Parquet, расчёт и запись/проверку четырёх файлов) меньше 300 секунд. Установка, сборка, старт контейнера и HTTP-загрузка не включены; это фактические единичные измерения, а не гарантия для любой машины. Python unittest также отдельно подтвердил полный самостоятельный CLI-запуск менее 300 секунд.

Первый параллельный запуск на Windows остановился при импорте библиотек с OpenBLAS allocation error / `MemoryError`; приёмка до данных не дошла. Повторные проверки выполнялись последовательно, с одним потоком BLAS/OpenMP и ограничением heap Node для npm/HTTP-теста. Системные настройки и код расчёта не менялись.

Фактические команды PowerShell из корня, пока файлы присутствовали:

```powershell
$env:OPENBLAS_NUM_THREADS = '1'
$env:OMP_NUM_THREADS = '1'
$env:PYTHON_BIN = (Resolve-Path .venv/Scripts/python.exe).Path
$env:REAL_DATA_DIR = (Resolve-Path data).Path
$env:MONEY_GRAPH_DATA_DIR = $env:REAL_DATA_DIR
$env:NODE_OPTIONS = '--max-old-space-size=256'
npm run test:dataset --workspace @money-graph/api
.venv/Scripts/python.exe -m unittest discover -s analytics/tests -v
```

Docker использовал уже собранные образы analytics `52cd2fd3405b` и api `42e2993a15fe`, входы монтировались только для чтения, сеть отключена. Запущенные сервисы приложения не заменялись:

```powershell
docker run --rm --network none --mount 'type=bind,source=D:/hack-18874c1c-xi/data,target=/data,readonly' --env MONEY_GRAPH_DATA_DIR=/data money-graph-analytics python -m unittest discover -s analytics/tests -v
docker run --rm --network none --mount 'type=bind,source=D:/hack-18874c1c-xi/data,target=/data,readonly' --env REAL_DATA_DIR=/data --env PYTHON_BIN=/opt/venv/bin/python --env OPENBLAS_NUM_THREADS=1 --env OMP_NUM_THREADS=1 money-graph-api node --test apps/api/test/dataset.integration.cjs
```

После успешных проверок `data/nodes.parquet`, `data/edges.parquet` и `data/transactions.parquet` удалены по явному поручению владельца. В `data/`, `runs/` и `artifacts/` остались только `.gitkeep`; временные загрузки и результаты тесты очищают сами, Docker-контейнеры удалены через `--rm`. В индексе и достижимой истории проверяемой ветки Parquet и реальные экспорты отсутствуют. Для повторной приёмки данные нужно предоставить отдельно. Браузерный сценарий, обновление старого поля health и финальное демо этой проверкой не закрываются.

## Обновление health и повторная приёмка — 23.09.2026

Проверена ветка `yerasyl-branch-back` на основе `e504693` с изменениями health из этого отчёта. `GET /api/health` теперь возвращает ровно `{ "status": "ok", "service": "api" }`: доступность HTTP, без устаревшего `analytics: "not_implemented"`. Общий тип и описание контракта обновлены; текущий frontend не читает удалённое поле. Статус `completed` по-прежнему требует успешного Python-процесса и проверки четырёх артефактов.

TDD: сначала изменён строгий HTTP-тест; запуск `node --test --test-name-pattern='health reports' apps/api/test/http.test.cjs` упал из-за лишнего поля `analytics`. После минимального изменения controller и общего типа тот же тест прошёл. Затем выполнены общие проверки:

| Команда | Фактический результат |
| :--- | :--- |
| `npm test` | 13 командных тестов и 103 теста API прошли |
| `npm run typecheck` | Прошла для всех workspace |
| `node --import tsx --test apps/web/tests/*.test.ts` | 51/51 прошли |
| `npm run build` | Contracts, API и production frontend собраны; в PowerShell задано `NEXT_TELEMETRY_DISABLED=1` |
| `npm run team:check`, `npm run check:structure`, `git diff --check` | Прошли |
| `npm run test:dataset --workspace @money-graph/api` | 1/1; 2 248 исходных gid сохранены, JSON и три CSV проверены; процесс **2 165,016 ms**, процесс + backend-валидация **2 289 ms** |

Последний замер выполнен на Windows x64, Node v24.14.0, Python 3.13.12, Intel Core i5-11400H. Использованы вновь предоставленные владельцем Parquet тех же размеров, команды и ограничения потоков из предыдущего раздела. Замер не включает установку, сборку, HTTP-загрузку и браузер.

Первый `docker compose up --build --wait` оборвался при потере соединения с Docker Engine. Desktop находился в `stopping`; штатный `docker desktop restart --timeout 45` восстановил движок. Повторная сборка с кэшем выявила пустой `/workspace/apps/api/package.json` внутри образа при корректном исходном файле. Выполнены `docker compose build --no-cache` и `docker compose up --wait`: обе команды прошли, API и web healthy. Код и зависимости для обхода сбоя не менялись. `docker compose exec -T api python -m money_graph --check-environment` вернул `pipeline_implemented: true`, Python 3.12.14; живой HTTP health соответствует новому контракту.

Сценарий установки, схема текущего решения, подготовка трёх типов узлов и показ на пять минут записаны в [DEMO.md](DEMO.md). Наличие сценария не означает проведённую командную репетицию.

### Настоящий браузерный сценарий

Playwright/Chromium 128 на Windows открыл `http://localhost:3000/` с production frontend и API из пересобранного Docker Compose. Без fixture и подмен HTTP через форму загружены три предоставленных Parquet: получены POST 202 / `running`, затем JSON HTTP 200 и `completed` без ошибки. Для этого запуска API сообщил **2 384 ms** процесса вместе с валидацией; от нажатия кнопки до подтверждения готового графа автоматизацией прошло **8 909 ms**. Второй интервал включает загрузку, polling, браузер и накладные расходы автоматизации, поэтому не подменяет внешний benchmark CLI.

Проверены:

- Точное множество всех **2 248** строковых gid на графе и совпадение с исходным `nodes.parquet`; **3 119** направленных рёбер со стрелками, **107** кластеров, принадлежность узлов и все **19** изолятов.
- Три узла, выбранные по данным: обычный связанный non-seed вне топа, изолят и depth=4. Поиск, фокус и карточки совпали с JSON по gid, роли, кластеру, глубине, seed, evidence, обеим оценкам, точным денежным строкам, степеням, числу транзакций, отношению потоков, связям, ограничениям и гипотезе кластера. Формат отображения оценок учтён: три знака после запятой.
- Три поиска с проверкой карточек заняли **1 459 ms**, меньше 60 секунд. Экземпляр Cytoscape и координаты узлов сохранились; новые layout не запускались. Это измерение автоматизации, а не пользовательское исследование.
- Таблица из 20 приоритетов согласована с JSON по gid, оценке и объяснению; переход из топа в карточку и переход по связи работают.
- Через каждую кнопку скачан CSV: `nodes_roles.csv` — 2 248 строк / 461 397 B, `clusters.csv` — 107 строк / 37 146 B, `top_nodes.csv` — 20 строк / 7 152 B. Проверены заголовки, все строки и поля относительно JSON, точные gid и денежные строки. Байты скачиваний совпали с повторным реальным HTTP GET того же неизменного экспорта и с исходными файлами Python на диске.
- Ошибок JavaScript страницы в ходе сценария не зарегистрировано.

Браузерный инструмент не предоставил тело наблюдаемого download-ответа (`response.body()` вернул пустой Buffer), поэтому побайтовая проверка использовала отдельный настоящий HTTP GET того же run_id и дополнительное сравнение с файлами расчёта. Ответы и CSV не подменялись. Локальные вспомогательные скрипты и выгрузки находились только в игнорируемом `artifacts/`; новые зависимости для проверки не устанавливались. В отчёт не включены реальные gid, строки транзакций или содержимое выгрузок.

### Завершение проверки и очистка

Изменения health и отчёт о браузерном прогоне сохранены в `86abf3a`. После `git fetch origin` проверены три ветки: собственная удалённая `e504693`, Илья и Родион — `53f2437`; все уже включены в текущую историю, новые изменения отсутствовали. Три обычных merge завершились `Already up to date`, конфликтов нет.

После проверки по поручению владельца удалены три вновь предоставленных Parquet из `data/`, входы и результаты единственного созданного браузером запуска из `runs/`, скачанные CSV из `artifacts/browser-downloads/` и временного `.playwright-mcp/`. API остановлен перед очисткой своего запуска и снова запущен через `docker compose up --wait`; оба сервиса healthy, health соответствует контракту. В `data/` и `runs/` остались только `.gitkeep`; в `artifacts/` сохранены лишь игнорируемые вспомогательные скрипты и журналы без исходных строк. В Git добавлены только код, тест и Markdown-документы, без данных и экспортов. Для повторного расчёта нужно вновь предоставить три входных файла.
