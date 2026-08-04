import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};

export async function run() {
    await Scripting.sleep(1500);

    const indicator = Main.panel.statusArea['network-quality-ip@local'];
    if (!indicator)
        throw new Error('Network Quality & IP indicator was not added to the panel');
    if (!indicator._graph)
        throw new Error('The 60-second graph was not created');
    if (!indicator.menu)
        throw new Error('The indicator menu was not created');

    indicator.menu.open();
    await Scripting.sleep(250);
    indicator.menu.close();
}
