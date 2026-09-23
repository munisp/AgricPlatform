import { memo, useCallback, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput
} from 'react-native';
import { isAbortError } from '../api/client';
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

const AnimalCard = memo(function AnimalCard({ animal }: { animal: Animal }) {
  return (
    <Card>
      <Text style={styles.line}>
        {animal.species} · {animal.breed} · {animal.sex}
      </Text>
      <Muted>
        {animal.id}
        {animal.tagId ? ` · tag ${animal.tagId}` : ''} · {animal.status}
      </Muted>
    </Card>
  );
});

/** Memoized form option button: skips re-render unless its selection flips. */
const OptionButton = memo(function OptionButton({
  option,
  selected,
  onSelect
}: {
  option: string;
  selected: boolean;
  onSelect: (option: string) => void;
}) {
  return (
    <PrimaryButton
      label={selected ? `✓ ${option}` : option}
      onPress={() => onSelect(option)}
    />
  );
});

function animalKey(animal: Animal): string {
  return animal.id;
}

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

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await listMyAnimals(client, { signal });
        if (signal?.aborted) return;
        setAnimals(res.data);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load your animals');
      }
    },
    [client]
  );

  // Reload on mount + on focus, plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  const pickSpecies = useCallback((next: string) => {
    const nextSpecies = next as LivestockSpecies;
    setSpecies(nextSpecies);
    setBreed(BREEDS[nextSpecies][0]);
  }, []);

  const pickSex = useCallback((next: string) => {
    setSex(next as AnimalSex);
  }, []);

  const toggleForm = useCallback(() => setShowForm((open) => !open), []);

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
      if (isAbortError(err)) return;
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

  const form = showForm ? (
    <Card>
      <CardTitle>Register an animal</CardTitle>

      <Text style={styles.label}>Species</Text>
      {SPECIES.map((option) => (
        <OptionButton
          key={option}
          option={option}
          selected={option === species}
          onSelect={pickSpecies}
        />
      ))}

      <Text style={styles.label}>Breed</Text>
      {BREEDS[species].map((option) => (
        <OptionButton
          key={option}
          option={option}
          selected={option === breed}
          onSelect={setBreed}
        />
      ))}

      <Text style={styles.label}>Sex</Text>
      {SEXES.map((option) => (
        <OptionButton key={option} option={option} selected={option === sex} onSelect={pickSex} />
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
  ) : null;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <FlatList
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      data={animals}
      keyExtractor={animalKey}
      ListHeaderComponent={
        <>
          {error ? <ErrorNotice message={error} /> : null}
          <Card>
            <CardTitle>My animals ({animals.length})</CardTitle>
            {animals.length === 0 ? (
              <Muted>No animals registered yet — register your first animal below.</Muted>
            ) : null}
          </Card>
        </>
      }
      renderItem={renderAnimal}
      ListFooterComponent={
        <>
          <Card>
            <PrimaryButton
              label={showForm ? 'Close form' : 'Register animal'}
              onPress={toggleForm}
            />
          </Card>
          {form}
        </>
      }
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={7}
      removeClippedSubviews
    />
    </KeyboardAvoidingView>
  );
}

const renderAnimal = ({ item }: { item: Animal }) => <AnimalCard animal={item} />;

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
