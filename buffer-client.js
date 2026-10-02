const {
  BUFFER_API_URL,
  BUFFER_REQUEST_TIMEOUT_MS
} = require("./config");

const ACCOUNT_QUERY = `
  query BufferAccount {
    account { organizations { id name } }
  }
`;

const CHANNELS_QUERY = `
  query BufferChannels($input: ChannelsInput!) {
    channels(input: $input) {
      id name displayName service organizationId
      isDisconnected isLocked isQueuePaused
    }
  }
`;

const POSTS_QUERY = `
  query BufferPosts($first: Int, $after: String, $input: PostsInput!) {
    posts(first: $first, after: $after, input: $input) {
      edges { node { id text channelId status dueAt createdAt assets { source mimeType type } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const POST_QUERY = `
  query BufferPost($input: PostInput!) {
    post(input: $input) { id text channelId status dueAt createdAt assets { source mimeType type } }
  }
`;

const CREATE_POST_MUTATION = `
  mutation BufferCreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id channelId status dueAt } }
      ... on MutationError { message }
    }
  }
`;

function parseRateLimits(header) {
  if (!header) return [];
  return header.split(/,\s*(?=")/).map((entry) => ({
    name: entry.match(/"([^"]+)"/)?.[1],
    remaining: Number(entry.match(/\br=(\d+)/)?.[1]),
    resetsInSeconds: Number(entry.match(/\bt=(\d+)/)?.[1])
  })).filter((item) => item.name && Number.isFinite(item.remaining));
}

class BufferApiError extends Error {
  constructor(message, { code, uncertain = false, retryAfterSeconds, status } = {}) {
    super(message);
    this.name = "BufferApiError";
    this.code = code;
    this.uncertain = uncertain;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

class BufferClient {
  constructor({
    apiKey = process.env.BUFFER_API_KEY,
    endpoint = BUFFER_API_URL,
    timeoutMs = BUFFER_REQUEST_TIMEOUT_MS,
    fetchImpl = global.fetch
  } = {}) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.lastRateLimits = [];
  }

  async request(query, variables = {}, { mutation = false } = {}) {
    if (!this.apiKey) throw new BufferApiError("BUFFER_API_KEY est absent.", { code: "CONFIGURATION" });
    const exhausted = this.lastRateLimits.find((limit) => limit.remaining <= 0);
    if (exhausted) throw new BufferApiError(`Quota Buffer atteint. Attendre ${exhausted.resetsInSeconds} secondes.`, {
      code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: exhausted.resetsInSeconds, status: 429
    });
    let response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      // Après l'envoi d'une mutation, une coupure réseau laisse le résultat incertain.
      throw new BufferApiError(
        mutation ? "Réponse Buffer incertaine après la création." : "Buffer est injoignable.",
        { code: "NETWORK", uncertain: mutation, status: error.name }
      );
    }

    this.lastRateLimits = parseRateLimits(response.headers.get("ratelimit"));
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    if (response.status === 429) {
      throw new BufferApiError(`Quota Buffer atteint. Attendre ${retryAfterSeconds || "le délai indiqué par Buffer"} secondes.`, {
        code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds, status: 429
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new BufferApiError(`Réponse Buffer illisible (HTTP ${response.status}).`, {
        code: "INVALID_RESPONSE", uncertain: mutation && (response.ok || response.status >= 500), status: response.status
      });
    }
    if (!response.ok) {
      throw new BufferApiError(`Buffer a répondu HTTP ${response.status}.`, {
        code: payload.errors?.[0]?.extensions?.code || "HTTP_ERROR",
        uncertain: mutation && response.status >= 500,
        status: response.status
      });
    }
    if (payload.errors?.length) {
      const first = payload.errors[0];
      throw new BufferApiError(`Erreur GraphQL Buffer (${first.extensions?.code || "UNKNOWN"}).`, {
        code: first.extensions?.code,
        uncertain: mutation && ["UNEXPECTED", "INTERNAL_SERVER_ERROR"].includes(first.extensions?.code)
      });
    }
    return payload.data;
  }

  async getOrganizations() {
    return (await this.request(ACCOUNT_QUERY)).account.organizations;
  }

  async getChannels(organizationId) {
    return (await this.request(CHANNELS_QUERY, { input: { organizationId } })).channels;
  }

  async getPosts(organizationId, channelIds, statuses) {
    const result = [];
    let after = null;
    do {
      const data = await this.request(POSTS_QUERY, {
        first: 100,
        after,
        input: {
          organizationId,
          sort: [{ field: "createdAt", direction: "desc" }],
          filter: { channelIds, status: statuses }
        }
      });
      result.push(...data.posts.edges.map((edge) => edge.node));
      after = data.posts.pageInfo.hasNextPage ? data.posts.pageInfo.endCursor : null;
    } while (after);
    return result;
  }

  async getPost(id) {
    return (await this.request(POST_QUERY, { input: { id } })).post;
  }

  async createPost({ channelId, text, imageUrl, dueAt, service, type = "post" }) {
    const input = {
      channelId,
      text,
      schedulingType: "automatic",
      mode: dueAt ? "customScheduled" : "addToQueue",
      assets: [{ image: { url: imageUrl } }]
    };
    if (!["facebook", "instagram"].includes(service)) {
      throw new BufferApiError("Réseau Buffer manquant ou non pris en charge.", { code: "CONFIGURATION" });
    }
    // Cette intégration ne prend en charge que les publications avec image.
    if (type !== "post") throw new BufferApiError("Seul le type post est pris en charge pour ces images.", { code: "CONFIGURATION" });
    input.metadata = { [service]: service === "instagram"
      ? { type, shouldShareToFeed: true }
      : { type } };
    if (dueAt) input.dueAt = dueAt;
    const data = await this.request(CREATE_POST_MUTATION, { input }, { mutation: true });
    if (!data.createPost.post) {
      throw new BufferApiError(data.createPost.message || "Buffer a refusé la publication.", {
        code: "MUTATION_ERROR"
      });
    }
    return data.createPost.post;
  }
}

module.exports = { BufferClient, BufferApiError, parseRateLimits };
