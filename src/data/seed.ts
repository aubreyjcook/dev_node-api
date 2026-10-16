/**
 * Sample tasks used to seed the in-memory store at startup.
 *
 * These are `TaskWriteInput` values, not `Task` values, and the difference is the
 * whole point: an input has no `id`, `createdAt` or `updatedAt`, because those
 * are the server's to decide. Seeding through the same input type that `POST`
 * uses means there is exactly one code path that can create a task.
 *
 * Set `SEED_DATA=false` in `.env` to start with an empty list instead.
 */

import type { TaskWriteInput } from '../types/task.ts';

export const sampleTasks: readonly TaskWriteInput[] = [
  {
    title: 'Read the HTTP and REST fundamentals chapter',
    description:
      'docs/01-http-and-rest-fundamentals.md covers methods, status codes and headers from first principles.',
    priority: 'high',
    completed: false,
  },
  {
    title: 'Send a request with curl',
    description: 'Try the examples in docs/07-testing-the-api.md against your local server.',
    priority: 'medium',
    completed: false,
  },
  {
    title: 'Break something on purpose',
    description:
      'POST a task with an empty title, or request a task that does not exist, and read the response carefully.',
    priority: 'medium',
    completed: false,
  },
  {
    title: 'Install a Node version with nvm',
    description: 'Run `nvm use` in the project root; it reads the version from .nvmrc.',
    priority: 'low',
    completed: true,
  },
];
