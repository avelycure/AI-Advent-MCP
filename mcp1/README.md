# Дни 16–17. MCP-клиент и сервер вокруг GitHub API

Это единый учебный проект для двух последовательных заданий:

- MCP-сервер на `http://127.0.0.1:3000/mcp`;
- MCP-клиент, который получает список инструментов через `listTools()` и
  вызывает выбранный инструмент через `callTool()`;
- простой инструмент `hello` из дня 16;
- read-only инструмент `github_repository_stats` из дня 17.

GitHub-инструмент обходит через REST API все репозитории, доступные токену, и
возвращает агрегированную статистику: количество репозиториев, звёзды, форки,
открытые issue/PR, основные языки и небольшой top-N.

## Установка и токен

Требуется Node.js 20.3 или новее.

```bash
cd mcp1
npm install
cp ../secrets/keys.example ../secrets/.env
chmod 600 ../secrets/.env
```

Впишите токен в `../secrets/.env`:

```dotenv
GITHUB_TOKEN=github_pat_...
```

Файл `secrets/.env` исключён из Git.

## Раздельный запуск сервера и клиента

В первом терминале:

```bash
cd mcp1
npm run server
```

Сервер продолжит работать и выведет:

```text
MCP server listening on http://127.0.0.1:3000/mcp
```

Во втором терминале:

```bash
cd mcp1
npm run client -- --list
```

В поле `tools` должны быть два инструмента: `hello` и
`github_repository_stats`.

Вызов GitHub-инструмента:

```bash
npm run client -- \
  --tool github_repository_stats \
  --arguments '{"visibility":"all","top":3}'
```

Команда `npm start` запускает клиент. Сервер должен быть уже запущен отдельной
командой `npm run server`.

## Входные параметры GitHub-инструмента

- `visibility`: `all`, `public` или `private`;
- `affiliations`: `owner`, `collaborator`, `organization_member`;
- `includeForks`: учитывать форки;
- `includeArchived`: учитывать архивные репозитории;
- `top`: размер списка лидеров, от 1 до 20.

Важно: при `visibility: "all"` агрегаты приватных репозиториев и обезличенные
строки top-N попадут в ответ инструмента. Если агент использует внешнюю LLM, эти
данные будут отправлены её провайдеру. Для анализа только открытых данных
задайте `visibility: "public"`.

## Проверка

```bash
npm test
```

Тесты запускают настоящий MCP client/server transport, проверяют оба
инструмента, пагинацию GitHub и защиту токена. GitHub API в тестах подменён,
поэтому сеть и настоящий токен не нужны.
