import { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput
} from 'react-native';
import { useApiClient } from '../api/context';
import { listMyAnimals, registerAnimal } from '../api/endpoints';
import type { Animal, AnimalSex, LivestockSpecies } from '../api/types';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton, styles as ui } from './ui';

const SPECIES: LivestockSpecies[] = ['cattle', 'sheep', 'goat', 'chicken', 'pig'];
const SEXES: AnimalSex[] = ['female', 'male'];

/** Breeds accepted by the registry (mirrors LIVESTOCK_BREEDS in shared). */
const BREEDS: Record<LivestockSpecies, string[]> = {
  cattle: ['White Fulani', 'Red Bororo', 'Sokoto Gudali', 'Muturu'],
  sheep: ['Yankasa', 'Balami', 'Uda'],
  goat: ['West African Dwarf', 'Sahel', 'Red Sokoto'],
  chicken: ['Broiler', 'Layer', 'Noiler'],
  pig: ['Large White', 'Landrace', 'Duroc']
};

/**
 * My livestock: registered animals (GET /livestock/animals/mine) with a
 * minimal register-animal form (POST /livestock/animals). Registration is
 * idempotency-keyed by the client, so an offline retry cannot create
 * duplicate national IDs.
 */
export function LivestockScreen({ state = 'Kano' }: { state?: string }) {
  const client = useApiClient();
  const [animals, setAnimals] = useState<Animal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [species, setSpecies] = useState<LivestockSpecies>('cattle');
  const [breed, setBreed] = useState(BREEDS.cattle[0]);
  const [sex, setSex] = useState<AnimalSex>('female');
  const [tagId, setTagId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listMyAnimals(client);
      setAnimals(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your animals');
    }
  }, [client]);

  // Reload on mount + on focus, plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  function pickSpecies(next: LivestockSpecies) {
    setSpecies(next);
    setBreed(BREEDS[next][0]);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await registerAnimal(client, {
        species,
        breed,
        sex,
        state,
        tagId: tagId.trim() || undefined
      });
      setShowForm(false);
      setTagId('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register the animal');
    } finally {
      setBusy(false);
    }
  }

  if (error && !animals) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!animals) {
    return <Loading />;
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      {error ? <ErrorNotice message={error} /> : null}

      <Card>
        <CardTitle>My animals ({animals.length})</CardTitle>
        {animals.length === 0 ? (
          <Muted>No animals registered yet — register your first animal below.</Muted>
        ) : (
          animals.map((animal) => (
            <Card key={animal.id}>
              <Text style={styles.line}>
                {animal.species} · {animal.breed} · {animal.sex}
              </Text>
              <Muted>
                {animal.id}
                {animal.tagId ? ` · tag ${animal.tagId}` : ''} · {animal.status}
              </Muted>
            </Card>
          ))
        )}
        <PrimaryButton
          label={showForm ? 'Close form' : 'Register animal'}
          onPress={() => setShowForm((open) => !open)}
        />
      </Card>

      {showForm ? (
        <Card>
          <CardTitle>Register an animal</CardTitle>

          <Text style={styles.label}>Species</Text>
          {SPECIES.map((option) => (
            <PrimaryButton
              key={option}
              label={option === species ? `✓ ${option}` : option}
              onPress={() => pickSpecies(option)}
            />
          ))}

          <Text style={styles.label}>Breed</Text>
          {BREEDS[species].map((option) => (
            <PrimaryButton
              key={option}
              label={option === breed ? `✓ ${option}` : option}
              onPress={() => setBreed(option)}
            />
          ))}

          <Text style={styles.label}>Sex</Text>
          {SEXES.map((option) => (
            <PrimaryButton
              key={option}
              label={option === sex ? `✓ ${option}` : option}
              onPress={() => setSex(option)}
            />
          ))}

          <Text style={styles.label}>Ear tag (optional)</Text>
          <TextInput
            accessibilityLabel="Ear tag"
            placeholder="e.g. KD-1234"
            value={tagId}
            onChangeText={setTagId}
            style={styles.input}
            editable={!busy}
          />

          <Text style={ui.muted}>Registered in {state} — the national ID is issued automatically.</Text>
          <PrimaryButton
            label={busy ? 'Registering…' : 'Submit registration'}
            onPress={() => void submit()}
            disabled={busy}
          />
        </Card>
      ) : null}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  line: { fontSize: 15, fontWeight: '600', marginBottom: 4, color: '#1b1b1b' },
  label: { marginTop: 12, marginBottom: 4, fontWeight: '600' },
  input: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cfcfcf',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16
  }
});
