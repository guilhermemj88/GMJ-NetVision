import { describe, expect, it } from 'vitest';
import { HOST_RESULT_LIMIT, hostAddress, searchHosts } from './host-search';

const HOSTS = [
  { id: '1', name: 'BHE-VTA-6730-MPLS-01', managementIp: '10.20.0.11', ip: '10.20.0.11' },
  { id: '2', name: 'BHE-RNJ-6730-MPLS-02', displayName: 'RNJ borda', managementIp: '', ip: '10.30.5.7' },
  { id: '3', name: 'sw-acesso-01', managementIp: '172.16.0.9', detectedHostname: 'SWITCH-FUNDOS' },
];

describe('searchHosts', () => {
  it('sem termo devolve todos, ordenados por nome', () => {
    expect(searchHosts(HOSTS, '').items.map((h) => h.id)).toEqual(['2', '1', '3']); // BHE-RNJ < BHE-VTA < sw-acesso
  });
  it('por nome, sem diferenciar maiusculas; tambem por nome de exibicao e hostname detectado', () => {
    expect(searchHosts(HOSTS, 'vta').items.map((h) => h.id)).toEqual(['1']);
    expect(searchHosts(HOSTS, 'BORDA').items.map((h) => h.id)).toEqual(['2']);
    expect(searchHosts(HOSTS, 'fundos').items.map((h) => h.id)).toEqual(['3']);
  });
  it('por IP, inteiro ou parcial; usa o ip do dispositivo quando nao ha IP de gerenciamento', () => {
    expect(searchHosts(HOSTS, '172.16.0.9').items.map((h) => h.id)).toEqual(['3']);
    expect(searchHosts(HOSTS, '30.5').items.map((h) => h.id)).toEqual(['2']);
    expect(hostAddress(HOSTS[1]!)).toBe('10.30.5.7');
  });
  it('varios termos precisam casar todos', () => {
    expect(searchHosts(HOSTS, 'bhe 6730 rnj').items.map((h) => h.id)).toEqual(['2']);
    expect(searchHosts(HOSTS, 'bhe 172').items).toEqual([]);
  });
  it('limita o resultado exibido mas informa o total', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: String(i), name: `H-${i}`, managementIp: `10.0.0.${i}` }));
    const result = searchHosts(many, 'h-');
    expect(result.items.length).toBe(HOST_RESULT_LIMIT);
    expect(result.total).toBe(120);
  });
  it('nunca inventa hosts: entrada vazia e consulta sem resultado devolvem vazio', () => {
    expect(searchHosts([], 'x')).toEqual({ items: [], total: 0 });
    expect(searchHosts(HOSTS, 'zzz')).toEqual({ items: [], total: 0 });
  });
});
