/**
 * Code mode's worker thread entry (#463 L4), bundled beside the harness as
 * dist/codemode-worker.js: the agent bundle has no node_modules for
 * pi-codemode to find its own worker file in. durable/pi.ts points the
 * sandbox at it.
 */
import "@earendil-works/pi-codemode/worker";
