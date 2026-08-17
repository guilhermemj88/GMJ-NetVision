# Coleta futura de counters SNMP

Taxas devem sempre usar o intervalo real medido entre as amostras:

```text
rate_bits_per_second = (delta_counter_octets * 8) / delta_time_real_seconds
```

Exemplo: se as leituras ocorrerem em `10:00:00.218` e `10:00:31.874`, o divisor é `31.656` segundos, nunca o intervalo configurado de 30 segundos. Usar o intervalo nominal cria bursts artificiais quando há jitter de polling.

## Regras necessárias

- preferir `ifHCInOctets` e `ifHCOutOctets` (`Counter64`) em interfaces rápidas;
- registrar timestamp monotônico o mais próximo possível de cada leitura;
- descartar o primeiro ponto, que não possui delta anterior;
- identificar reboot por `sysUpTime`, descontinuidade ou counter menor que o anterior;
- não interpretar reset como wrap;
- tratar wrap apenas quando o tipo e a proximidade do limite o tornam plausível;
- usar `ifHighSpeed` quando a velocidade não couber em `ifSpeed`;
- marcar velocidade desconhecida em vez de inventar uma capacidade;
- rejeitar ou sinalizar taxas fisicamente impossíveis acima da capacidade, considerando tolerância operacional;
- armazenar qualidade da amostra, origem e timestamps junto da taxa calculada;
- evitar polling sincronizado de toda a frota; aplicar jitter controlado sem alterar o cálculo pelo tempo real.

## Implementação atual

- strings recebidas como `Uint8Array` são decodificadas como UTF-8, sem converter bytes
  em listas de números ASCII;
- `ifHCInOctets`/`ifHCOutOctets` têm precedência e os counters de 32 bits são fallback;
- `ifHighSpeed` tem precedência quando é positivo; caso contrário usa-se `ifSpeed`;
- taxas usam o intervalo real entre timestamps;
- polls com menos de 45 segundos desde a amostra persistida não gravam uma falsa taxa zero;
- erros, descartes e estado operacional acompanham cada amostra histórica;
- resposta HTTP processada não é confundida com saúde da fonte: os testes retornam um
  `ConnectionTestResult.state`, e walks/gets sem valores válidos não marcam a fonte como conectada.

Para counters de 32 bits em links rápidos, o wrap pode ocorrer em segundos. Se `Counter64` não existir, o intervalo máximo seguro precisa ser calculado a partir da capacidade da interface e o resultado deve ter qualidade reduzida.
