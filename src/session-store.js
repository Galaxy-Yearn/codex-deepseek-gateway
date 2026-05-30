export class SessionStore {
  constructor({ maxToolCallMessages = 1000 } = {}) {
    this.map = new Map();
    this.toolCallMessages = new Map();
    this.conversations = new Map();
    this.maxToolCallMessages = maxToolCallMessages;
  }

  get(id) {
    return this.map.get(id) || null;
  }

  set(id, value) {
    this.map.set(id, value);
    for (const turn of Array.isArray(value?.history) ? value.history : []) {
      this.indexAssistantMessage(turn.assistantMessage);
    }
    return value;
  }

  getConversation(id) {
    const responseId = this.conversations.get(id);
    return responseId ? this.get(responseId) : null;
  }

  setConversation(id, responseId) {
    if (id && responseId) this.conversations.set(String(id), responseId);
  }

  indexAssistantMessage(message) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) return;
    for (const toolCall of message.tool_calls) {
      if (!toolCall?.id) continue;
      this.toolCallMessages.set(toolCall.id, cloneAssistantMessage(message));
      while (this.toolCallMessages.size > this.maxToolCallMessages) {
        const oldestKey = this.toolCallMessages.keys().next().value;
        this.toolCallMessages.delete(oldestKey);
      }
    }
  }

  getAssistantMessageForToolCall(callId) {
    return this.toolCallMessages.get(callId) || null;
  }

  delete(id) {
    return this.map.delete(id);
  }

  clear() {
    this.map.clear();
    this.toolCallMessages.clear();
    this.conversations.clear();
  }
}

function cloneAssistantMessage(message) {
  return {
    ...message,
    tool_calls: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => ({
          ...toolCall,
          function: toolCall.function ? { ...toolCall.function } : toolCall.function,
        }))
      : undefined,
  };
}
