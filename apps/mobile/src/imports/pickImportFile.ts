import { getDocumentAsync } from 'expo-document-picker'

import type { ImportFile } from './importApi'

/**
 * Opens the device's file picker and returns the chosen file with its content, or null when the person
 * gave up. Any type is accepted because phones label OFX files inconsistently; the API decides whether
 * the content is a valid OFX. The content is read once, to be sent, and never inspected or logged.
 */
export async function pickImportFile(
  readContent: (uri: string) => Promise<Blob> = async (uri) => (await fetch(uri)).blob(),
): Promise<ImportFile | null> {
  const result = await getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false })
  const asset = result.canceled ? undefined : result.assets[0]
  if (!asset) return null
  return { name: asset.name, content: await readContent(asset.uri) }
}
