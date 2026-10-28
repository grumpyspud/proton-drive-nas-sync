export async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of gen) out.push(item);
    return out;
}
