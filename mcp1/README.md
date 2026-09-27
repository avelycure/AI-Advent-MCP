# День 16. Подключение MCP

Минимальный пример на Node.js с раздельно запущенными процессами:

- `src/server.js` поднимает MCP-сервер на `http://127.0.0.1:3000/mcp` и публикует инструмент `hello`;
- `src/client.js` подключается к серверу по Streamable HTTP и получает список инструментов через `listTools()`;
- `test/connection.test.js` автоматически запускает сервер отдельным процессом и проверяет соединение.

## Установка

Требуется Node.js 20 или новее.

```bash
cd mcp1
npm install
```

## Запуск сервера

В первом терминале:

```bash
npm run server
```

Сервер продолжит работать и выведет:

```text
MCP server listening on http://127.0.0.1:3000/mcp
```

## Запуск клиента

Во втором терминале, также из папки `mcp1`:

```bash
npm run client
```

Команда `npm start` делает то же самое.

Ожидаемый результат:

```text
MCP connection established: http://127.0.0.1:3000/mcp

Available tools (1):
[
  {
    "name": "hello",
    "description": "Returns a greeting from the demo MCP server",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  }
]
```

Адрес можно изменить переменными окружения:

```bash
MCP_PORT=4000 npm run server
MCP_URL=http://127.0.0.1:4000/mcp npm run client
```

## Автоматическая проверка

```bash
npm test
```

Тест считается успешным, если отдельный серверный процесс запущен, клиент
подключился к нему и получил инструмент `hello`.
