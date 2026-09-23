"use client";

import type { HealthResponse } from "@money-graph/contracts";
import { useEffect, useState } from "react";

const apiBaseUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api").replace(/\/+$/, "");

type HealthState =
  | { status: "pending" }
  | { status: "success"; response: HealthResponse }
  | { status: "error"; message: string };

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value && value.status === "ok" &&
    "service" in value && value.service === "api" &&
    "analytics" in value && value.analytics === "not_implemented"
  );
}

export default function HomePage() {
  const [health, setHealth] = useState<HealthState>({ status: "pending" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    setHealth({ status: "pending" });

    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8000);

    async function checkHealth() {
      try {
        const response = await fetch(`${apiBaseUrl}/health`, {
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`API вернул ошибку HTTP ${response.status}.`);
        }

        const payload: unknown = await response.json();
        if (!isHealthResponse(payload)) {
          throw new Error("Ответ API не соответствует контракту health.");
        }

        if (active) setHealth({ status: "success", response: payload });
      } catch (error: unknown) {
        if (!active) return;
        const message = timedOut
          ? "API не ответил за 8 секунд. Проверьте, что backend запущен."
          : error instanceof Error
            ? error.message
            : "Не удалось проверить доступность API.";
        setHealth({ status: "error", message });
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkHealth();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  return (
    <main className="page">
      <header className="masthead">
        <a className="brand" href="/" aria-label="Money Graph — главная">
          <span className="brand-mark" aria-hidden="true">M</span>
          Money Graph
        </a>
        <span className="stage">Основа проекта</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">Анализ графа переводов</p>
        <h1 id="page-title">От данных<br />к объяснимым связям.</h1>
        <p className="summary">Каркас готов; аналитический расчёт ещё не реализован.</p>
        <p className="description">
          Здесь появятся карта переводов, поиск по узлу и результаты аналитики.
          Сейчас можно проверить соединение интерфейса с backend.
        </p>
      </section>

      <section className="connection card" aria-labelledby="connection-title">
        <div className="connection-copy">
          <p className="eyebrow">Соединение</p>
          <h2 id="connection-title">Доступность API</h2>
          <div className={`health health-${health.status}`} role="status" aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            <span>
              {health.status === "pending" && "Проверяем соединение…"}
              {health.status === "success" && "API доступен"}
              {health.status === "error" && "API недоступен или вернул ошибку"}
            </span>
          </div>
          {health.status === "error" && <p className="error-message">{health.message}</p>}
          {health.status === "success" && (
            <p className="connection-note">Backend работает. Аналитический модуль пока не подключён.</p>
          )}
          <code className="endpoint">{apiBaseUrl}/health</code>
        </div>
        <button
          type="button"
          className="check-button"
          disabled={health.status === "pending"}
          onClick={() => setAttempt((current) => current + 1)}
        >
          {health.status === "pending" ? "Проверяем…" : "Проверить снова"}
        </button>
      </section>

      <section className="team-section" aria-labelledby="team-title">
        <div className="section-heading">
          <h2 id="team-title">Три зоны ответственности</h2>
          <p>Один общий контракт</p>
        </div>
        <div className="team-grid">
          <article className="team-card card">
            <span className="member-number">01</span>
            <h3>Илья</h3>
            <p className="member-role">Frontend</p>
            <p>Интерфейс, граф и поиск узлов.</p>
            <span className="technology">Next.js · TypeScript · Cytoscape.js</span>
          </article>
          <article className="team-card card">
            <span className="member-number">02</span>
            <h3>Ерасыл</h3>
            <p className="member-role">Backend</p>
            <p>Единый API и запуск расчёта.</p>
            <span className="technology">NestJS · TypeScript</span>
          </article>
          <article className="team-card card">
            <span className="member-number">03</span>
            <h3>Родион</h3>
            <p className="member-role">Аналитика</p>
            <p>Метрики, роли, кластеры и объяснения.</p>
            <span className="technology">Python CLI · pandas · NetworkX</span>
          </article>
        </div>
      </section>

      <footer>Обязательные требования ТЗ → реализация → проверка на данных</footer>
    </main>
  );
}
