// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

import React from 'react';
import BenchmarkSection from '../components/BenchmarkSection';
import Footer from '../components/Footer';
import FadeInSection from '../components/FadeInSection';

const BenchmarkPage: React.FC = () => {
  return (
    <div style={{ paddingTop: 72 }}>
      <FadeInSection>
        {/* The benchmark section is this route's whole subject, so its title is
            the page's h1. On the landing page the same section keeps its h2
            below the hero's h1. */}
        <BenchmarkSection headingLevel="h1" />
      </FadeInSection>
      <FadeInSection>
        <Footer />
      </FadeInSection>
    </div>
  );
};

export default BenchmarkPage;
