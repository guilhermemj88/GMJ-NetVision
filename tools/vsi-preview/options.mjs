// Opcoes de empacotamento do preview minimo de conformidade (usadas por build.mjs e pelos testes).
// Entrada unica, formato CJS, sem divisao de codigo; o bundle nao inclui API, workers, SSH, SNMP nem mitigacao.
export function previewBuildOptions(outfile) {
  return {
    entryPoints: ['apps/api/src/vsi-preview/vsi-preview-main.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
  };
}
