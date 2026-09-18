-- pgTAP isolado numa migration propria de proposito: ele e framework de
-- teste, e mante-lo separado permite excluir esta migration do push para
-- producao sem mexer em nenhuma outra.
create extension if not exists pgtap with schema extensions;
