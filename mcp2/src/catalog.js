export const LEARNING_RESOURCES = Object.freeze([
  {
    id: "mcp-architecture",
    title: "MCP: архитектура и жизненный цикл",
    kind: "guide",
    difficulty: "beginner",
    durationMinutes: 45,
    summary: "Знакомство с host, client, server, transport и жизненным циклом MCP-сессии.",
    topics: ["mcp", "architecture", "protocol", "transport"],
    modules: [
      "Разобрать роли host, client и server",
      "Проследить initialize и согласование capabilities",
      "Сравнить stdio и Streamable HTTP transports",
    ],
  },
  {
    id: "mcp-tools",
    title: "Проектирование MCP-инструментов",
    kind: "workshop",
    difficulty: "intermediate",
    durationMinutes: 60,
    summary: "Практика схем ввода, structuredContent, аннотаций и безопасных ошибок.",
    topics: ["mcp", "tools", "schemas", "structuredcontent", "security"],
    modules: [
      "Описать инструмент и его JSON Schema",
      "Вернуть текстовый и структурированный результат",
      "Добавить read-only и destructive annotations",
    ],
  },
  {
    id: "mcp-orchestration",
    title: "Оркестрация нескольких MCP-серверов",
    kind: "lab",
    difficulty: "advanced",
    durationMinutes: 90,
    summary: "Лабораторная работа по discovery, маршрутизации и длинным tool-flow.",
    topics: ["mcp", "orchestration", "routing", "multi-server", "testing"],
    modules: [
      "Зарегистрировать несколько MCP-сессий",
      "Построить единый реестр обнаруженных инструментов",
      "Проверить порядок вызовов и остановку при ошибке",
    ],
  },
  {
    id: "mcp-security",
    title: "Безопасность MCP-серверов",
    kind: "checklist",
    difficulty: "intermediate",
    durationMinutes: 55,
    summary: "Практический чек-лист доверия, валидации, логирования и безопасных границ MCP.",
    topics: ["mcp", "security", "validation", "permissions", "logging"],
    modules: [
      "Определить границы доверия клиента и сервера",
      "Проверить схемы, размеры входа и безопасные ошибки",
      "Ограничить запись файлов и утечки через логи",
    ],
  },
  {
    id: "node-testing",
    title: "Интеграционные тесты на Node.js",
    kind: "reference",
    difficulty: "intermediate",
    durationMinutes: 50,
    summary: "Детерминированные тесты процессов, HTTP-серверов и отказов без внешней сети.",
    topics: ["node.js", "testing", "integration", "http"],
    modules: [
      "Запускать дочерние процессы на случайном порту",
      "Ожидать readiness без sleep",
      "Гарантированно освобождать процессы и временные файлы",
    ],
  },
]);

function normalize(value) {
  return value.toLocaleLowerCase("ru-RU").trim();
}

function relevance(resource, terms) {
  const title = normalize(resource.title);
  const summary = normalize(resource.summary);
  const topics = resource.topics.map(normalize);
  const matchedTerms = terms.filter((term) => (
    title.includes(term)
    || summary.includes(term)
    || topics.some((topic) => topic.includes(term))
  ));
  const relevanceScore = matchedTerms.reduce((score, term) => (
    score
    + (title.includes(term) ? 4 : 0)
    + (topics.includes(term) ? 3 : 0)
    + (summary.includes(term) ? 1 : 0)
  ), 0);
  return { matchedTerms, relevanceScore };
}

export function searchLearningResources({ topic, maxResults }) {
  const terms = normalize(topic).split(/\s+/u).filter(Boolean);
  const matches = LEARNING_RESOURCES
    .map((resource, index) => ({ resource, index, ...relevance(resource, terms) }))
    .filter(({ relevanceScore }) => relevanceScore > 0)
    .sort((left, right) => (
      right.relevanceScore - left.relevanceScore || left.index - right.index
    ))
    .slice(0, maxResults)
    .map(({ resource, matchedTerms, relevanceScore }) => ({
      id: resource.id,
      title: resource.title,
      kind: resource.kind,
      difficulty: resource.difficulty,
      summary: resource.summary,
      matchedTerms,
      relevanceScore,
    }));

  return {
    topic,
    count: matches.length,
    resources: matches,
  };
}

export function getLearningResource(resourceId) {
  return LEARNING_RESOURCES.find((resource) => resource.id === resourceId) ?? null;
}
