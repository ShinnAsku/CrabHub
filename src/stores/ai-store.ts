import { create } from "zustand";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sqlBlocks?: string[];
  streaming?: boolean;
  timestamp: number;
}

export interface Conversation {
  id: string;
  connectionId: string;
  messages: Message[];
  createdAt: number;
  lastActiveAt: number;
  topic?: string;
}

interface AIState {
  // Current session state
  messages: Message[];
  activeConversationId: string | null;
  isStreaming: boolean;
  
  // Conversation history per connection
  conversations: Record<string, Conversation[]>;
  
  // Actions
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  clearMessages: () => void;
  setIsStreaming: (streaming: boolean) => void;
  
  // Conversation management
  saveConversation: (connectionId: string) => void;
  loadConversation: (connectionId: string, conversationId: string) => Conversation | null;
  getConversations: (connectionId: string) => Conversation[];
  setActiveConversation: (id: string | null) => void;
  clearHistory: (connectionId: string) => void;
  deleteConversation: (conversationId: string) => void;
}

const STORAGE_KEY_PREFIX = "crabhub-ai-conversations-";

function loadConversations(connectionId: string): Conversation[] {
  try {
    const saved = localStorage.getItem(`${STORAGE_KEY_PREFIX}${connectionId}`);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error("Failed to load AI conversations:", e);
  }
  return [];
}

function saveConversations(connectionId: string, conversations: Conversation[]) {
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${connectionId}`, JSON.stringify(conversations));
  } catch (e) {
    console.error("Failed to save AI conversations:", e);
  }
}

export const useAIStore = create<AIState>((set, get) => ({
  // Initial state
  messages: [],
  activeConversationId: null,
  isStreaming: false,
  conversations: {},
  
  // Message actions
  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),
  
  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    })),
  
  clearMessages: () =>
    set({ messages: [] }),
  
  setIsStreaming: (streaming) =>
    set({ isStreaming: streaming }),
  
  // Conversation management
  saveConversation: (connectionId) => {
    const { messages, conversations } = get();
    if (messages.length === 0) return;
    
    const now = Date.now();
    const existingConversations = conversations[connectionId] || [];
    
    // Check if we're updating an existing conversation
    const activeId = get().activeConversationId;
    if (activeId) {
      const updated = existingConversations.map((conv) =>
        conv.id === activeId
          ? { ...conv, messages, lastActiveAt: now }
          : conv
      );
      const newConversations = { ...conversations, [connectionId]: updated };
      set({ conversations: newConversations });
      saveConversations(connectionId, updated);
    } else {
      // Create new conversation
      const newConversation: Conversation = {
        id: `conv-${now}`,
        connectionId,
        messages,
        createdAt: now,
        lastActiveAt: now,
        topic: messages[0]?.content.slice(0, 50) || "New conversation",
      };
      
      const updated = [...existingConversations, newConversation];
      const newConversations = { ...conversations, [connectionId]: updated };
      set({ 
        conversations: newConversations,
        activeConversationId: newConversation.id,
      });
      saveConversations(connectionId, updated);
    }
  },
  
  loadConversation: (connectionId, conversationId) => {
    const conversations = get().conversations[connectionId] || loadConversations(connectionId);
    const conv = conversations.find((c) => c.id === conversationId);
    
    if (conv) {
      set({ 
        messages: conv.messages,
        activeConversationId: conversationId,
      });
      return conv;
    }
    return null;
  },
  
  getConversations: (connectionId) => {
    const conversations = get().conversations[connectionId] || loadConversations(connectionId);
    return conversations.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  },
  
  setActiveConversation: (id) => {
    if (id) {
      set({ activeConversationId: id });
    } else {
      set({ 
        activeConversationId: null,
        messages: [],
      });
    }
  },
  
  clearHistory: (connectionId) => {
    set((state) => ({
      conversations: {
        ...state.conversations,
        [connectionId]: [],
      },
      messages: [],
      activeConversationId: null,
    }));
    saveConversations(connectionId, []);
  },
  
  deleteConversation: (conversationId) => {
    const { activeConversationId, conversations } = get();
    
    // Find which connection this conversation belongs to
    for (const [connectionId, convs] of Object.entries(conversations)) {
      const filtered = convs.filter((c) => c.id !== conversationId);
      if (filtered.length !== convs.length) {
        const updated = { ...conversations, [connectionId]: filtered };
        set({ conversations: updated });
        saveConversations(connectionId, filtered);
        
        if (activeConversationId === conversationId) {
          set({ 
            activeConversationId: null,
            messages: [],
          });
        }
        break;
      }
    }
  },
}));
