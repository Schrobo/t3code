export const forgejoV15Fixture = {
  version: { version: "15.0.7" },
  settings: { default_paging_num: 30, max_response_items: 50 },
  user: {
    login: "forgejo-v15-user",
    full_name: "Forgejo 15 User",
    avatar_url: "https://forgejo-v15.test/avatars/1",
    ignored_by_t3: true,
  },
  repository: {
    full_name: "owner/repo",
    html_url: "https://forgejo-v15.test/owner/repo",
    clone_url: "https://forgejo-v15.test/owner/repo.git",
    ssh_url: "git@forgejo-v15.test:owner/repo.git",
    private: true,
    default_branch: "main",
    owner: { login: "owner" },
  },
  pullRequest: {
    number: 51,
    title: "Forgejo 15 pull request",
    html_url: "https://forgejo-v15.test/owner/repo/pulls/51",
    state: "open",
    merged: false,
    updated_at: "2026-08-31T12:00:00.000Z",
    base: { ref: "main" },
    head: { ref: "feature/forgejo" },
  },
} as const;
