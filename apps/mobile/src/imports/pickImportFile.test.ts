import { getDocumentAsync } from 'expo-document-picker'

import { pickImportFile } from './pickImportFile'

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }))

const pick = getDocumentAsync as jest.Mock

describe('pickImportFile', () => {
  it('returns the chosen file with its content read from the device', async () => {
    pick.mockResolvedValueOnce({ canceled: false, assets: [{ name: 'extrato.ofx', uri: 'file:///cache/extrato.ofx' }] })
    const content = new Blob(['OFXHEADER:100'])
    const readContent = jest.fn(async () => content)
    await expect(pickImportFile(readContent)).resolves.toEqual({ name: 'extrato.ofx', content })
    expect(readContent).toHaveBeenCalledWith('file:///cache/extrato.ofx')
    expect(pick).toHaveBeenCalledWith({ type: '*/*', copyToCacheDirectory: true, multiple: false })
  })

  it('returns null, reading nothing, when the person gives up', async () => {
    pick.mockResolvedValueOnce({ canceled: true, assets: null })
    const readContent = jest.fn()
    await expect(pickImportFile(readContent)).resolves.toBeNull()
    expect(readContent).not.toHaveBeenCalled()
  })
})
