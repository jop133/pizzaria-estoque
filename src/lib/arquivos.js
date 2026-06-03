// Converte arquivos selecionados em imagens. PDFs (ex: documento escaneado pelo
// WhatsApp) são renderizados em imagem (uma por página). A biblioteca pdfjs é
// carregada SOB DEMANDA (lazy) — só baixa quando há um PDF para ler.

function ehPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

async function pdfParaImagens(file) {
  const pdfjs = await import('pdfjs-dist')
  // Worker empacotado pelo Vite (clássico) — compatível com navegadores de
  // celular que não suportam "module workers".
  const PdfWorker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')).default
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()

  const buffer = await file.arrayBuffer()
  const pdf = await pdfjs.getDocument({ data: buffer }).promise
  const baseNome = file.name.replace(/\.pdf$/i, '')
  const imagens = []

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n)
    const base = page.getViewport({ scale: 1 })
    // Renderiza visando ~2000px de largura (bom p/ leitura), no máximo 3x.
    const scale = Math.min(3, 2000 / base.width)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')
    // fundo branco (PDFs podem ter transparência)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92))
    if (blob) {
      imagens.push(new File([blob], `${baseNome}-pag${n}.jpg`, { type: 'image/jpeg' }))
    }
  }
  return imagens
}

// Recebe uma lista de arquivos e devolve só imagens (PDFs viram 1 imagem/página).
// Se `apenasPrimeira` for true, retorna no máximo 1 imagem por PDF (telas de foto única).
export async function expandirArquivosParaImagens(files, apenasPrimeira = false) {
  const saida = []
  for (const file of files) {
    if (ehPdf(file)) {
      const imgs = await pdfParaImagens(file)
      saida.push(...(apenasPrimeira ? imgs.slice(0, 1) : imgs))
    } else {
      saida.push(file)
    }
  }
  return saida
}
