export async function registerShortcut(
  accelerator: string,
  onTrigger: () => void
): Promise<() => void> {
  const normalizedAccelerator = accelerator
    .replaceAll('CmdOrCtrl', 'CommandOrControl')
    .replaceAll('CmdOrControl', 'CommandOrControl');

  try {
    const { isRegistered, register, unregister } = await import('@tauri-apps/plugin-global-shortcut');

    if (await isRegistered(normalizedAccelerator)) {
      await unregister(normalizedAccelerator);
    }

    await register(normalizedAccelerator, (event) => {
      if (event.state === 'Pressed') {
        onTrigger();
      }
    });

    return () => {
      void unregister(normalizedAccelerator).catch(() => undefined);
    };
  } catch {
    return () => undefined;
  }
}
