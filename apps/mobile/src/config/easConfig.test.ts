import easConfig from '../../eas.json'

type BuildProfile = { distribution?: string; environment?: string; env?: Record<string, string>; extends?: string }
const profiles = easConfig.build as Record<string, BuildProfile>

/**
 * The EAS build profiles (DEV-159). A release build talks only to the API address it was built with
 * (`src/config/apiUrl.ts`), so that address comes from the EAS environment of the profile, kept on
 * expo.dev, and never from this repository.
 */
describe('eas.json', () => {
  it('offers an internal preview build and a store production build', () => {
    expect(profiles.preview?.distribution).toBe('internal')
    expect(profiles.production?.distribution ?? 'store').toBe('store')
  })

  it('takes every build profile from its own EAS environment', () => {
    expect(profiles.preview?.environment).toBe('preview')
    expect(profiles.production?.environment).toBe('production')
  })

  it('never writes the API address or any public variable into the repository', () => {
    for (const [name, profile] of Object.entries(profiles)) {
      const publicVariables = Object.keys(profile.env ?? {}).filter((key) => key.startsWith('EXPO_PUBLIC_'))
      expect({ name, publicVariables }).toEqual({ name, publicVariables: [] })
    }
  })
})
