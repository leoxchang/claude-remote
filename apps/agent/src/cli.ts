import { Command } from 'commander';

/** 构造 Agent CLI；具体命令由后续任务逐步注册。 */
export function createCli(): Command {
  return new Command()
    .name('claude-remote-agent')
    .description('Claude Remote Mac agent')
    .showHelpAfterError();
}

/** 解析并执行 CLI，返回进程退出码。 */
export async function main(argv: readonly string[]): Promise<number> {
  await createCli().parseAsync([...argv]);
  return 0;
}