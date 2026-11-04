// SPDX-License-Identifier: AGPL-3.0-only

import { it, expect } from 'vitest';
import { McpHelpTool, registerHelpTopic } from '../src/plugins/mcp-bridge/rv-mcp-help-tool';
it('lists, serves and removes optional help topics', async () => {
 const tool = new McpHelpTool();
 expect(JSON.parse(await tool.webHelp('experiments')).error).toContain('Unknown topic');
 const off = registerHelpTopic('experiments', { summary: 'Studies', content: 'Experiment guide' });
 expect(JSON.parse(await tool.webHelp('')).topics.experiments).toBe('Studies');
 expect(JSON.parse(await tool.webHelp('EXPERIMENTS')).guide).toBe('Experiment guide');
 off();
 expect(JSON.parse(await tool.webHelp('')).topics.experiments).toBeUndefined();
});
it('does not let an old disposer remove a newer guide', async () => {
 const a = registerHelpTopic('test-topic', { summary: 'a', content: 'a' });
 const b = registerHelpTopic('test-topic', { summary: 'b', content: 'b' });
 a();
 expect(JSON.parse(await new McpHelpTool().webHelp('test-topic')).guide).toBe('b');
 b(); a();
});
