import { defineConfig } from 'astro/config';

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'murmur';
const isGitHubPages = process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  site: `https://mahirocoko.github.io/${repoName}`,
  base: isGitHubPages ? `/${repoName}/` : '/',
  output: 'static',
});
