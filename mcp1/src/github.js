const DEFAULT_API_URL = "https://api.github.com";
const API_VERSION = "2026-03-10";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;

export class GitHubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export function formatGitHubError(error) {
  if (error instanceof GitHubApiError) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return "GitHub API request was cancelled.";
  }
  return "GitHub API request failed.";
}

function nextPage(linkHeader) {
  if (!linkHeader) return null;

  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }

  return null;
}

function apiError(response) {
  if (response.status === 401) {
    return new GitHubApiError(
      "GitHub rejected GITHUB_TOKEN. Check that the token is valid.",
      response.status,
    );
  }

  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");
    let suffix = "";
    if (retryAfter) {
      suffix = ` Retry after ${retryAfter}.`;
    } else if (remaining === "0" && reset) {
      const resetAt = new Date(Number(reset) * 1000);
      if (!Number.isNaN(resetAt.valueOf())) {
        suffix = ` Rate limit resets at ${resetAt.toISOString()}.`;
      }
    }
    return new GitHubApiError(
      `GitHub API refused the request with HTTP ${response.status}.${suffix}`,
      response.status,
    );
  }

  return new GitHubApiError(
    `GitHub API request failed with HTTP ${response.status}.`,
    response.status,
  );
}

async function fetchRepositories({
  token,
  visibility,
  affiliations,
  fetchImpl,
  apiUrl,
  signal,
}) {
  const url = new URL("/user/repos", apiUrl);
  url.searchParams.set("per_page", String(PAGE_SIZE));
  url.searchParams.set("visibility", visibility);
  url.searchParams.set("affiliation", affiliations.join(","));
  url.searchParams.set("sort", "full_name");
  url.searchParams.set("direction", "asc");

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "ai-advent-github-mcp",
    "X-GitHub-Api-Version": API_VERSION,
  };

  const repositories = [];
  let pageUrl = url.toString();
  let lastResponse;
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  for (let page = 0; page < MAX_PAGES && pageUrl; page += 1) {
    const requestedUrl = new URL(pageUrl);
    if (requestedUrl.origin !== url.origin) {
      throw new GitHubApiError(
        "GitHub returned a pagination link for an unexpected origin.",
        502,
      );
    }

    lastResponse = await fetchImpl(requestedUrl, {
      headers,
      signal: requestSignal,
    });
    if (!lastResponse.ok) throw apiError(lastResponse);

    const payload = await lastResponse.json();
    if (!Array.isArray(payload)) {
      throw new GitHubApiError("GitHub returned an unexpected response.", 502);
    }

    repositories.push(...payload);
    pageUrl = nextPage(lastResponse.headers.get("link"));
  }

  if (pageUrl) {
    throw new GitHubApiError(
      `GitHub returned more than ${MAX_PAGES * PAGE_SIZE} repositories.`,
      502,
    );
  }

  return {
    repositories,
    rateLimit: {
      limit: Number(lastResponse?.headers.get("x-ratelimit-limit") || 0),
      remaining: Number(lastResponse?.headers.get("x-ratelimit-remaining") || 0),
      resetAt: lastResponse?.headers.get("x-ratelimit-reset")
        ? new Date(
          Number(lastResponse.headers.get("x-ratelimit-reset")) * 1000,
        ).toISOString()
        : null,
    },
  };
}

function topRepositories(repositories, limit) {
  return [...repositories]
    .sort((left, right) => (
      right.stargazers_count - left.stargazers_count
      || right.forks_count - left.forks_count
      || left.full_name.localeCompare(right.full_name)
    ))
    .slice(0, limit)
    .map((repository) => ({
      name: repository.private ? "(private repository)" : repository.full_name,
      private: Boolean(repository.private),
      language: repository.language || null,
      stars: Number(repository.stargazers_count || 0),
      forks: Number(repository.forks_count || 0),
      openItems: Number(repository.open_issues_count || 0),
      archived: Boolean(repository.archived),
      url: repository.private ? null : repository.html_url,
      updatedAt: repository.updated_at,
    }));
}

export async function collectRepositoryStats({
  token,
  visibility = "all",
  affiliations = ["owner", "collaborator", "organization_member"],
  includeForks = true,
  includeArchived = true,
  top = 5,
  fetchImpl = globalThis.fetch,
  apiUrl = process.env.GITHUB_API_URL || DEFAULT_API_URL,
  signal,
} = {}) {
  if (!token) {
    throw new GitHubApiError(
      "GITHUB_TOKEN is not configured on the MCP server.",
      401,
    );
  }

  const fetched = await fetchRepositories({
    token,
    visibility,
    affiliations,
    fetchImpl,
    apiUrl,
    signal,
  });
  const repositories = fetched.repositories.filter((repository) => (
    (includeForks || !repository.fork)
    && (includeArchived || !repository.archived)
  ));

  const languages = {};
  for (const repository of repositories) {
    const language = repository.language || "Unknown";
    languages[language] = (languages[language] || 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      visibility,
      affiliations,
      includeForks,
      includeArchived,
    },
    repositories: {
      total: repositories.length,
      public: repositories.filter((item) => !item.private).length,
      private: repositories.filter((item) => item.private).length,
      forks: repositories.filter((item) => item.fork).length,
      archived: repositories.filter((item) => item.archived).length,
    },
    totals: {
      stars: repositories.reduce(
        (sum, item) => sum + Number(item.stargazers_count || 0),
        0,
      ),
      forks: repositories.reduce(
        (sum, item) => sum + Number(item.forks_count || 0),
        0,
      ),
      openItems: repositories.reduce(
        (sum, item) => sum + Number(item.open_issues_count || 0),
        0,
      ),
      sizeKb: repositories.reduce(
        (sum, item) => sum + Number(item.size || 0),
        0,
      ),
    },
    languages: Object.fromEntries(
      Object.entries(languages).sort((left, right) => (
        right[1] - left[1] || left[0].localeCompare(right[0])
      )),
    ),
    topRepositories: topRepositories(repositories, top),
    rateLimit: fetched.rateLimit,
  };
}

export function collectRepositoryStatsWithAuth(githubAuth, options = {}) {
  return collectRepositoryStats({
    ...options,
    token: githubAuth,
  });
}
