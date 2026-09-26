# День 16. Подключение MCP

Минимальный локальный пример на Node.js:

- `src/server.js` поднимает MCP-сервер через `stdio` и публикует инструмент `hello`;
- `src/client.js` запускает сервер, устанавливает MCP-соединение и получает список инструментов через `listTools()`;
- `test/connection.test.js` автоматически проверяет соединение и содержимое списка.

## Запуск

Требуется Node.js 20 или новее.

```bash
npm install
npm start
```

Ожидаемый результат:

```text
MCP connection established successfully.

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

## Проверка

```bash
npm test
```

Тест считается успешным, если клиент подключился, сервер вернул ровно один
инструмент и его имя — `hello`.
