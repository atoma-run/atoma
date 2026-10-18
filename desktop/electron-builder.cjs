const signed = process.env.ATOMA_COMPUTE_SIGNED === '1';
module.exports = {
  appId: 'run.atoma.compute', icon: 'src/viz/public/icons/atoma-512.png', productName: 'Atoma Compute',
  directories: { app: 'dist/compute-desktop', output: 'dist/compute-installers' },
  files: ['!node_modules/**/*', 'main.cjs', 'preload.cjs', 'runtime.mjs', 'renderer.js', 'renderer.css', 'index.html', 'icon.png', 'package.json'],
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true },
  asar: true, asarUnpack: ['runtime.mjs'], npmRebuild: false,
  afterPack: async context => {
    const path = await import('node:path');
    const asar = await import('@electron/asar');
    const resources = context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, 'Atoma Compute.app', 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
    const allowed = new Set(['icon.png', 'index.html', 'main.cjs', 'package.json', 'preload.cjs', 'renderer.css', 'renderer.js', 'runtime.mjs']);
    const files = asar.listPackage(path.join(resources, 'app.asar'));
    if (files.length !== allowed.size || files.some(file => !allowed.has(file.slice(1)))) throw new Error('Unexpected content in the desktop package');
  },
  forceCodeSigning: signed,
  publish: signed ? [{ provider: 'generic', url: 'https://github.com/atoma-run/atoma/releases/download/compute-desktop-stable/', channel: `latest-${process.env.ATOMA_COMPUTE_ARCH || process.arch}` }] : null,
  artifactName: 'Atoma-Compute-${version}-${os}-${arch}.${ext}',
  mac: { category: 'public.app-category.developer-tools', target: ['dmg', 'zip'], hardenedRuntime: true,
    notarize: signed, ...(signed ? {} : { identity: '-' }) },
  win: { target: ['nsis'], signAndEditExecutable: true },
  nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true },
};
