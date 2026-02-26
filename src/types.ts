export interface WpArg {
  type?: string | string[];
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  items?: { type?: string; enum?: string[] };
}

export interface WpEndpoint {
  methods: string[];
  args: Record<string, WpArg>;
}

export interface WpRoute {
  namespace: string;
  methods: string[];
  endpoints: WpEndpoint[];
  _links?: Record<string, unknown>;
}

export interface WpIndex {
  name: string;
  description: string;
  url: string;
  home: string;
  namespaces: string[];
  routes: Record<string, WpRoute>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  route: string;
  methods: string[];
  pathParams: string[];
  endpointsByMethod: Map<string, WpEndpoint>;
}
