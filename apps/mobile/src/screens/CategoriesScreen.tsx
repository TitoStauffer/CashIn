import { useCallback, useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'

import { CATEGORY_NATURES, type CatalogApi, type Category, type CategoryNature, type Subcategory } from '../catalog/catalogApi'
import { ChoiceChips } from '../ui/ChoiceChips'
import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar as categorias. Tente novamente.'
const MISSING_CATEGORY_NAME = 'Informe o nome da categoria.'
const MISSING_SUBCATEGORY_NAME = 'Informe o nome da subcategoria.'

type Loaded = { key: string; categories: Category[] }
type Editing = { categoryId: string; subcategoryId?: string; name: string } | null

/**
 * The categories and subcategories of the active wallet, one nature at a time. The list belongs to a
 * wallet and a nature: when either changes, the old list leaves the screen before the new one is read,
 * so a category of another wallet is never shown as if it were this one's. Names are checked for blanks
 * here; uniqueness and removal of what is in use are the API's, and its message is shown.
 */
export function CategoriesScreen({ walletId, catalogApi }: { walletId: string; catalogApi: CatalogApi }) {
  const [nature, setNature] = useState<CategoryNature>('income')
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [newName, setNewName] = useState('')
  const [newSubcategory, setNewSubcategory] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Editing>(null)
  const key = `${walletId}:${nature}`

  useEffect(() => {
    let current = true
    void catalogApi.listCategories(nature)
      .then(({ items }) => {
        if (!current) return
        setLoaded({ key, categories: items })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [catalogApi, key, nature, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh)
  const categories = loaded?.key === key ? loaded.categories : null

  // A new wallet or nature starts clean: no half-typed name, open editor or old message carries over.
  // Adjusted while rendering, the way React recommends for state that follows a prop.
  const [formKey, setFormKey] = useState(key)
  if (formKey !== key) {
    setFormKey(key)
    setEditing(null)
    setNewName('')
    setNewSubcategory({})
    setFeedback(null)
  }

  if (loadError && !categories) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />

  const required = (value: string, message: string) => {
    if (value.trim()) return true
    setFeedback({ tone: 'error', message })
    return false
  }

  const create = () => {
    if (!required(newName, MISSING_CATEGORY_NAME)) return
    void run(async () => {
      await catalogApi.createCategory(newName.trim(), nature)
      setNewName('')
      return 'Categoria criada.'
    })
  }

  const saveEdit = () => {
    if (!editing) return
    if (!required(editing.name, editing.subcategoryId ? MISSING_SUBCATEGORY_NAME : MISSING_CATEGORY_NAME)) return
    const { categoryId, subcategoryId, name } = editing
    void run(async () => {
      if (subcategoryId) await catalogApi.renameSubcategory(categoryId, subcategoryId, name.trim())
      else await catalogApi.renameCategory(categoryId, name.trim())
      setEditing(null)
      return subcategoryId ? 'Subcategoria renomeada.' : 'Categoria renomeada.'
    })
  }

  const createSubcategory = (category: Category) => {
    const name = newSubcategory[category.id] ?? ''
    if (!required(name, MISSING_SUBCATEGORY_NAME)) return
    void run(async () => {
      await catalogApi.createSubcategory(category.id, name.trim())
      setNewSubcategory((previous) => ({ ...previous, [category.id]: '' }))
      return 'Subcategoria criada.'
    })
  }

  const confirmRemoval = (category: Category, subcategory?: Subcategory) => {
    const title = subcategory ? 'Excluir subcategoria' : 'Excluir categoria'
    const detail = subcategory
      ? `${subcategory.name} será excluída de ${category.name}.`
      : `${category.name} e as subcategorias dela serão excluídas.`
    Alert.alert(title, detail, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: () => void run(async () => {
          if (subcategory) await catalogApi.removeSubcategory(category.id, subcategory.id)
          else await catalogApi.removeCategory(category.id)
          return subcategory ? 'Subcategoria excluída.' : 'Categoria excluída.'
        }),
      },
    ])
  }

  const editor = (label: string) => editing ? (
    <View style={styles.editor}>
      <TextField label={label} value={editing.name} onChangeText={(name) => setEditing({ ...editing, name })} autoFocus />
      <PrimaryButton label="Salvar" onPress={saveEdit} busy={busy} />
      <LinkButton label="Cancelar edição" onPress={() => setEditing(null)} />
    </View>
  ) : null

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Categorias</Text>
      <ChoiceChips<CategoryNature> options={CATEGORY_NATURES} value={nature} onChange={setNature} />
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}
      {loadError ? (
        <View style={styles.card}>
          <FormMessage tone="error" message={loadError} />
          <LinkButton label="Tentar novamente" onPress={refresh} />
        </View>
      ) : null}

      <TextField label="Nome da nova categoria" value={newName} onChangeText={setNewName} />
      <PrimaryButton label="Criar categoria" onPress={create} busy={busy} />

      {!categories ? <LoadingState label="Carregando categorias…" /> : null}
      {categories && categories.length === 0 ? <Text style={formStyles.body}>Nenhuma categoria nesta natureza.</Text> : null}
      {categories?.map((category) => (
        <View key={category.id} style={styles.card}>
          {editing?.categoryId === category.id && !editing.subcategoryId ? editor(`Novo nome de ${category.name}`) : (
            <>
              <Text style={styles.primary}>{category.name}</Text>
              <View style={styles.actions}>
                <LinkButton label={`Renomear ${category.name}`} onPress={() => setEditing({ categoryId: category.id, name: category.name })} />
                <LinkButton label={`Excluir ${category.name}`} onPress={() => confirmRemoval(category)} />
              </View>
            </>
          )}
          {category.subcategories.map((subcategory) => (
            <View key={subcategory.id} style={styles.subcategory}>
              {editing?.subcategoryId === subcategory.id ? editor(`Novo nome de ${subcategory.name}`) : (
                <>
                  <Text style={styles.secondary}>{subcategory.name}</Text>
                  <View style={styles.actions}>
                    <LinkButton
                      label={`Renomear ${subcategory.name}`}
                      onPress={() => setEditing({ categoryId: category.id, subcategoryId: subcategory.id, name: subcategory.name })}
                    />
                    <LinkButton label={`Excluir ${subcategory.name}`} onPress={() => confirmRemoval(category, subcategory)} />
                  </View>
                </>
              )}
            </View>
          ))}
          <TextField
            label={`Nova subcategoria de ${category.name}`}
            value={newSubcategory[category.id] ?? ''}
            onChangeText={(name) => setNewSubcategory((previous) => ({ ...previous, [category.id]: name }))}
          />
          <LinkButton label={`Adicionar subcategoria a ${category.name}`} onPress={() => createSubcategory(category)} />
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.xs },
  subcategory: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs, marginLeft: spacing.md },
  editor: { gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  primary: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  secondary: { fontSize: typography.body, color: colors.text },
})
