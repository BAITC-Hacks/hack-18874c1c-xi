# Backend: результаты проверок 23.09.2026

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
