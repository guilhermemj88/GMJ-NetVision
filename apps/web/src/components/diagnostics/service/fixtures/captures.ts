/**
 * Saidas brutas usadas pelas fixtures de desenvolvimento do Diagnostico VSI/VPLS.
 *
 * PROVENIENCIA: capturas REAIS, sanitizadas, dos equipamentos (09/11/2026 no BHE-VTA-S6750;
 * 16/11/2026, sessao manual do operador, no BHE-VTA-6730 e BHE-LIKEE-6730) e leituras do
 * inventario SNMP do NetVision em 16/11/2026. Mesmo conteudo das fixtures de
 * `apps/api/src/infrastructure/mpls/vsi-mcp/__fixtures__` (MACs/System-ID com os 16 bits
 * finais trocados, `description` removida). `cfg26` esta TRUNCADA como foi recebida.
 * As entradas `snmp*` NAO sao saida de equipamento. Nada aqui e estado atual da rede.
 */
export const VSI_FIXTURE_CAPTURES = {
vsi3066: `<BHE-VTA-S6750-MPLS-01>display vsi name 3066-BGP-FLASHTELECOM verbose

 ***VSI Name               : 3066-BGP-FLASHTELECOM
    PW Signaling           : bgp
    Encapsulation Type     : vlan
    MTU                    : 1500
    VSI State              : up

    BGP RD                 : 268568:3066
    SiteID/Range/Offset    : 25/30/1
    Remote Label Block     : 36440/30/1
    Local Label Block      : 0/1016792/8/1

    Interface Name         : Vlanif3066
    State                  : up
    Ac Block State         : unblocked
    Last Up Time           : 2026/10/26 17:07:57

  **PW Information:

   *Peer Ip Address        : 10.100.101.6
    PW State               : up
    Local VC Label         : 1016797
    Remote VC Label        : 36464
    Negotiated Control Word: disable
    Tnl Type               : ldp
    OutInterface           : --
    Mac Flapping           : 0
    PW Last Up Time        : 2026/11/08 05:59:47
<BHE-VTA-S6750-MPLS-01>`,
mac3066: `<BHE-VTA-S6750-MPLS-01>display mac-address vsi 3066-BGP-FLASHTELECOM
-------------------------------------------------------------------------------
MAC Address    VLAN/VSI/BD   Learned-From        Type                Age
-------------------------------------------------------------------------------
14eb-08bf-0001 -/3066-BGP-FLASHTELECOM/- Eth-Trunk1          dynamic          141470
f0a9-511e-0002 -/3066-BGP-FLASHTELECOM/- Eth-Trunk6          dynamic          141465
-------------------------------------------------------------------------------
Total items: 2
<BHE-VTA-S6750-MPLS-01>`,
vlan3066: `<BHE-VTA-S6750-MPLS-01>display vlan 3066
VID          Ports
--------------------------------------------------------------------------------
3066         TG:Eth-Trunk1(U)

VID  Type     Status  Property  MAC-LRN STAT    BC  MC  UC  Description
--------------------------------------------------------------------------------
3066 common   enable  default   enable  disable FWD FWD FWD VLAN 3066
<BHE-VTA-S6750-MPLS-01>`,
trunk6: `<BHE-VTA-S6750-MPLS-01>display current-configuration interface Eth-Trunk6
#
interface Eth-Trunk6
 description <REMOVIDO>
 port link-type trunk
 undo port trunk allow-pass vlan 1
 port trunk allow-pass vlan 1602
 stp disable
 mode lacp-dynamic
#
return
<BHE-VTA-S6750-MPLS-01>`,
vif3064: `<BHE-VTA-S6750-MPLS-01>display current-configuration interface Vlanif3064
#
interface Vlanif3064
 description 3064-PONTUALNET-IP-BHE-MQT
 l2 binding vsi 3064-PONTUALNET-IP-BHE-MQT
#
return
<BHE-VTA-S6750-MPLS-01>`,
lag26: `<BHE-VTA-6730-MPLS-01>display eth-trunk 26
Eth-Trunk26's state information is:
Local:
LAG ID: 26                  WorkingMode: LACP
Preempt Delay: Disabled     Hash arithmetic: According to SIP-XOR-DIP
System Priority: 1          System ID: 00e0-fc00-0000
Least Active-linknumber: 1  Max Active-linknumber: 32
Operate status: down        Number Of Up Port In Trunk: 0
--------------------------------------------------------------------------------
ActorPortName          Status   PortType PortPri PortNo PortKey PortState Weight
XGigabitEthernet0/0/48 Unselect 10GE     32768   24     33857   10100000  1

Partner:
--------------------------------------------------------------------------------
ActorPortName          SysPri   SystemID        PortPri PortNo PortKey PortState
XGigabitEthernet0/0/48 65535    48a9-8ab6-0001  255     2      33      10110000

<BHE-VTA-6730-MPLS-01>`,
et4: `<BHE-VTA-6730-MPLS-01>display e-trunk 4
                            The E-Trunk information
E-TRUNK-ID : 4                          Revert-Delay-Time (s) : 120
Priority : 30                           System-ID : 2811-ecea-0002
Peer-IP : 10.100.101.3                  Source-IP : 10.100.101.0
State : Backup                          Causation : PRI
Send-Period (100ms) : 9                 Fail-Time (100ms) : 27
Peer-Priority : 20                      Peer-System-ID : 6ce8-7430-0003
Peer-Fail-Time (100ms) : 27             BFD-Session : likee
--------------------------------------------------------------------------------
                            The Member information
Type      ID  LocalPhyState  Work-Mode     State   Causation        Remote-ID
Eth-Trunk 13  Down           auto          Backup  PEER_MEMBER_UP   21
Eth-Trunk 26  Down           auto          Backup  PEER_MEMBER_UP   17
<BHE-VTA-6730-MPLS-01>`,
briefVta: `<BHE-VTA-6730-MPLS-01>display e-trunk brief
E-TRUNK-ID    State        Peer-IP          Source-IP
-----------------------------------------------------------
1             Backup       10.100.101.4     10.100.101.0
2             Master       10.100.101.4     10.100.101.0
4             Backup       10.100.101.3     10.100.101.0
5             Master       10.100.101.5     10.100.101.0
11            Master       10.100.101.11    10.100.101.0
13            Master       10.100.101.8     10.100.101.0
-----------------------------------------------------------
Total:6       Master:4     Backup:2         Init:0
<BHE-VTA-6730-MPLS-01>`,
cfg26: `<BHE-VTA-6730-MPLS-01>display current-configuration interface Eth-Trunk26
#
interface Eth-Trunk26
 description <REMOVIDO>
 port link-type trunk
 undo port trunk allow-pass vlan 1
 port trunk allow-pass vlan 820 3015 to 3016 3332 3502 3884
 mode lacp
 e-trunk 4 remote-eth-trunk 17`,
briefLikee: `<BHE-LIKEE-6730-MPLS-01>display e-trunk brief
E-TRUNK-ID    State        Peer-IP          Source-IP
-----------------------------------------------------------
2             Backup       10.100.101.8     10.100.101.3
3             Master       10.100.101.1     10.100.101.3
4             Master       10.100.101.0     10.100.101.3
5             Master       10.100.101.4     10.100.101.3
12            Backup       10.100.101.8     10.100.101.3
-----------------------------------------------------------
Total:5       Master:3     Backup:2         Init:0
<BHE-LIKEE-6730-MPLS-01>`,
lag17: `<BHE-LIKEE-6730-MPLS-01>display eth-trunk 17
Eth-Trunk17's state information is:
Local:
LAG ID: 17                  WorkingMode: LACP
Preempt Delay: Disabled     Hash arithmetic: According to SIP-XOR-DIP
System Priority: 1          System ID: 00e0-fc00-0000
Least Active-linknumber: 1  Max Active-linknumber: 32
Operate status: up          Number Of Up Port In Trunk: 1
--------------------------------------------------------------------------------
ActorPortName          Status   PortType PortPri PortNo PortKey PortState Weight
XGigabitEthernet0/0/3  Selected 10GE     32768   32770  33857   10111100  1

Partner:
--------------------------------------------------------------------------------
ActorPortName          SysPri   SystemID        PortPri PortNo PortKey PortState
XGigabitEthernet0/0/3  65535    48a9-8ab6-0001  255     1      33      10111100

<BHE-LIKEE-6730-MPLS-01>`,
cfg17: `<BHE-LIKEE-6730-MPLS-01>display current-configuration interface Eth-Trunk17
#
interface Eth-Trunk17
 description <REMOVIDO>
 port link-type trunk
 undo port trunk allow-pass vlan 1
 port trunk allow-pass vlan 820 3015 to 3016 3332 3502 3884
 mode lacp
 e-trunk 4 remote-eth-trunk 26
#
return
<BHE-LIKEE-6730-MPLS-01>`,
snmpLikee: `Inventário SNMP (banco do NetVision) — não é saída de equipamento
VSI 3072-QinQ-CDB-MANTIQUEIRA @ BHE-LIKEE-6730-MPLS-01
  leitura: 2026-11-16 13:50:19Z
  operationalStatus: UP   mtu: 2000   rd: 268568:53072
  AC  Eth-Trunk17.3072   status UP
  PW  10.100.101.2       state UP   labels 36706 / 35842   lido 13:50:19Z`,
snmpVta: `Inventário SNMP (banco do NetVision) — não é saída de equipamento
VSI 3072-QinQ-CDB-MANTIQUEIRA @ BHE-VTA-6730-MPLS-01
  leitura: 2026-11-16 13:51:10Z
  operationalStatus: DOWN   mtu: 2000   rd: 268568:53072
  AC  Eth-Trunk26.3072   status DOWN
  PW  10.100.101.2       state UP   labels 41335 / 35840   lido 2026-10-27 01:24:40Z  <- 20 dias antes da VSI
Interface Eth-Trunk26: adminStatus UP, operStatus UP (ifOperStatus)`,
} as const;
