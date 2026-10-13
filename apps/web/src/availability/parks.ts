import { computed, reactive, ref } from 'vue'
import * as v from 'valibot'

const CatalogSchema = v.pipe(
  v.object({
    defaultTarget: v.string(),
    groups: v.pipe(
      v.array(
        v.object({
          surface: v.picklist(['hard', 'grass']),
          label: v.pipe(v.string(), v.minLength(1)),
          parks: v.array(
            v.object({
              parkId: v.pipe(v.string(), v.regex(/^\d{4}$/)),
              parkName: v.pipe(v.string(), v.minLength(1)),
            }),
          ),
        }),
      ),
      v.minLength(1),
      v.maxLength(2),
    ),
  }),
  v.check((catalog) => {
    const keys = catalog.groups.flatMap((group) =>
      group.parks.map((park) => `${park.parkId}:${group.surface}`),
    )
    return (
      keys.includes(catalog.defaultTarget) &&
      new Set(keys).size === keys.length &&
      new Set(catalog.groups.map((group) => group.surface)).size === catalog.groups.length
    )
  }),
)
export type Park = {
  parkId: string
  parkName: string
  surface: 'hard' | 'grass'
  key: string
  label: string
}
// Populated from the API; no park definitions are bundled in the web app.
export const parks = reactive<Park[]>([])
const groups = ref<v.InferOutput<typeof CatalogSchema>['groups']>([])
export const parkGroups = computed(() => groups.value)
export const defaultTarget = ref('')
export function setParkCatalog(data: unknown): void {
  const catalog = v.parse(CatalogSchema, data)
  const options = catalog.groups.flatMap((group) =>
    group.parks.map((park) => ({
      ...park,
      surface: group.surface,
      label: group.label,
      key: `${park.parkId}:${group.surface}`,
    })),
  )
  parks.splice(0, parks.length, ...options)
  groups.value = catalog.groups
  defaultTarget.value = catalog.defaultTarget
}
