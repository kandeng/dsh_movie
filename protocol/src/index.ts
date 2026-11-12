/**
 * `@dsh-movie/protocol` - the shared client-server contract for dsh_movie.
 *
 * One typed source of truth imported by the DSH host (tsx, from source), the
 * browser client SDK, and the web app. It defines:
 * - {@link Principal} / {@link RoomRole} and principal helpers (Leg-agnostic);
 * - Leg B: ComfyUI-style workflow/prompt graphs and the execution-lifecycle WS
 *   envelope;
 * - Leg C: the direct RPC/WS channel envelope and namespace method contracts.
 *
 * Contract-as-code: pure types and tiny pure helpers only, no runtime proxies
 * and no external dependencies.
 *
 * @module @dsh-movie/protocol
 */

export * from './principal.ts'
export * from './leg-b.ts'
export * from './leg-c.ts'
export * from './workspace.ts'
export * from './nodes.ts'
export * from './movie.ts'
export * from './bridge.ts'
export * from './op-script.ts'
