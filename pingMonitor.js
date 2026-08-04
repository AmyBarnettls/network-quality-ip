import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isValidPingTarget, parsePingLine, SampleWindow} from './core.js';

export class PingMonitor {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._window = new SampleWindow();
        this._target = null;
        this._active = false;
        this._generation = 0;
        this._process = null;
        this._stream = null;
        this._cancellable = null;
        this._retrySource = 0;
        this._state = 'stopped';
        this._error = null;
    }

    start(target, reset = true) {
        this.stop(false);
        this._target = isValidPingTarget(target) ? target : '1.1.1.1';
        this._active = true;
        if (reset)
            this._window.reset();
        this._spawn();
    }

    restart(target = this._target) {
        this.start(target, true);
    }

    reset() {
        this._window.reset();
        this._emitUpdate();
    }

    stop(emitUpdate = true) {
        this._active = false;
        this._generation++;

        if (this._retrySource) {
            GLib.source_remove(this._retrySource);
            this._retrySource = 0;
        }

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._process) {
            try {
                this._process.force_exit();
            } catch (error) {
                console.debug(`Unable to stop ping cleanly: ${error.message}`);
            }
        }

        this._process = null;
        this._stream = null;
        this._state = 'stopped';
        this._error = null;
        if (emitUpdate)
            this._emitUpdate();
    }

    getSnapshot() {
        return {
            state: this._state,
            error: this._error,
            samples: this._window.getSamples(),
            stats: this._window.getStats(),
        };
    }

    _spawn() {
        if (!this._active)
            return;

        const generation = ++this._generation;
        this._cancellable = new Gio.Cancellable();
        this._state = 'starting';
        this._error = null;
        this._emitUpdate();

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_MERGE,
            });
            launcher.setenv('LC_ALL', 'C', true);
            this._process = launcher.spawnv([
                '/usr/bin/ping',
                '-n',
                '-O',
                '-i', '1',
                '-W', '1',
                this._target,
            ]);

            this._stream = new Gio.DataInputStream({
                base_stream: this._process.get_stdout_pipe(),
                close_base_stream: true,
            });
            this._state = 'running';
            this._emitUpdate();
            this._readNextLine(generation);
            this._waitForExit(generation);
        } catch (error) {
            this._handleFailure(generation, error);
        }
    }

    _readNextLine(generation) {
        if (!this._active || generation !== this._generation || !this._stream)
            return;

        this._stream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (stream, result) => {
                if (!this._active || generation !== this._generation)
                    return;

                try {
                    const [line] = stream.read_line_finish_utf8(result);
                    if (line === null)
                        return;

                    const event = parsePingLine(line);
                    if (event && this._window.record(event))
                        this._emitUpdate();

                    this._readNextLine(generation);
                } catch (error) {
                    if (!this._isCancelled(error))
                        this._handleFailure(generation, error);
                }
            }
        );
    }

    _waitForExit(generation) {
        this._process.wait_async(this._cancellable, (process, result) => {
            if (!this._active || generation !== this._generation)
                return;

            try {
                process.wait_finish(result);
                let message = 'ping exited unexpectedly';
                if (process.get_if_exited() && !process.get_successful())
                    message = `ping exited with status ${process.get_exit_status()}`;
                else if (process.get_if_signaled())
                    message = `ping was terminated by signal ${process.get_term_sig()}`;
                this._handleFailure(generation, new Error(message));
            } catch (error) {
                if (!this._isCancelled(error))
                    this._handleFailure(generation, error);
            }
        });
    }

    _handleFailure(generation, error) {
        if (!this._active || generation !== this._generation)
            return;

        this._generation++;
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = null;
        if (this._process) {
            try {
                this._process.force_exit();
            } catch (_error) {
                // The process may already have exited.
            }
        }
        this._process = null;
        this._stream = null;
        this._state = 'error';
        this._error = error.message;
        this._emitUpdate();

        if (!this._retrySource) {
            this._retrySource = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                5,
                () => {
                    this._retrySource = 0;
                    this._spawn();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _emitUpdate() {
        if (this._onUpdate)
            this._onUpdate(this.getSnapshot());
    }

    _isCancelled(error) {
        return typeof error.matches === 'function' &&
            error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    }
}
