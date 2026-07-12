/**
 * Mutex por clave: garantiza que solo una operación a la vez pueda correr
 * para una clave específica (ej. un SKU), sin bloquear otras claves.
 *
 * Esto evita condiciones de carrera del tipo "leer-modificar-escribir": si
 * dos procesos independientes (ej. un webhook y un job periódico) intentan
 * reconciliar el MISMO SKU casi al mismo tiempo, uno espera a que el otro
 * termine antes de leer el estado — así ninguno sobrescribe al otro con
 * una lectura desactualizada.
 */
export class KeyedMutex {
    private locks = new Map<string, Promise<void>>();

    async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
        // Encadenar detrás de cualquier operación previa pendiente para esta clave
        const previous = this.locks.get(key) ?? Promise.resolve();

        let release: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        this.locks.set(key, previous.then(() => current));

        await previous; // esperar turno

        try {
            return await fn();
        } finally {
            release!();
            // Limpiar si nadie más quedó esperando detrás de esta operación
            if (this.locks.get(key) === current) {
                this.locks.delete(key);
            }
        }
    }
}