# ZCode CLI

ZCode's Agent CLI provides an interactive terminal and non-interactive task execution. It is part of this pnpm workspace; build it from the repository root with the Node and pnpm versions in [mise.toml](../../mise.toml).

```sh
pnpm install --frozen-lockfile
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs doctor --json
```

The default artifact is a Node.js bundle with adjacent runtime resources. SEA packaging is optional. The Agent CLI differs from the root distribution launcher, which also supports Web startup.

See the [CLI usage guide (中文)](docs/usage/README.md) for setup, model configuration, permissions, sessions, MCP, skills, hooks, plugins, and reproducible batch tasks. The guide distinguishes current source behavior from older binaries and documents its verification limits.

Useful entry points:

- [Quick start and packaging](docs/usage/01-quickstart.md)
- [Model and runtime configuration](docs/usage/03-config.md)
- [Plugin development](docs/usage/10-plugins.md)
- [Hooks and workspace trust](docs/usage/09-hooks.md)
- [Batch tasks and trajectory capture](docs/usage/13-automation.md)
- [Design specifications](docs/design/v2/)
- [Contributor instructions](AGENTS.md)

Run `pnpm --filter @zcode/cli dev` for source development. CLI code validation follows the contributor instructions; CLI tests are separate from the root unit-test suite.

The repository root owns `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and `turbo.json`.
Do not create a second workspace or lockfile here: CLI packages depend on root
packages such as `@zcode/shared` and `@zcode/provider-node`. CLI aggregate commands
select only `apps/zcode-cli/packages/*` and `apps/zcode-cli/tools/*`; Turbo still
builds their dependencies in the root workspace before running the selected tasks.

```sh
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

Run `node --test scripts/test/cli-test-environment.test.mjs` from the repository
root to check workspace discovery, aggregate task scope, and dependency ordering.
